//! In-page act scripts and wait policy. No wry — unit-tested without the GUI.
use super::{Action, ClickButton};
use anyhow::{bail, Result};

/// Wait with no selector and no `url_contains` is a timed delay (never a timeout error).
pub(crate) fn wait_is_delay(selector: &Option<String>, url_contains: &Option<String>) -> bool {
    fn nonempty(s: &Option<String>) -> bool {
        s.as_deref().is_some_and(|s| !s.is_empty())
    }
    !nonempty(selector) && !nonempty(url_contains)
}

/// Default wheel delta in CSS pixels (not computer-tool notches).
const DEFAULT_DELTA_PX: i32 = 400;

fn reject_contains(sel: &str) -> Result<()> {
    if sel.to_ascii_lowercase().contains(":contains(") {
        bail!("invalid CSS selector (no :contains): {sel}");
    }
    Ok(())
}

fn reject_contains_opt(sel: Option<&str>) -> Result<()> {
    if let Some(s) = sel {
        reject_contains(s)?;
    }
    Ok(())
}

fn js_str_or_null(s: Option<&str>) -> String {
    match s {
        Some(s) => format!("{s:?}"),
        None => "null".into(),
    }
}

fn js_num_or_null(n: Option<f64>) -> String {
    match n {
        Some(v) => format!("{v}"),
        None => "null".into(),
    }
}

/// Find a node that actually scrolls: explicit selector, overflowing document, or
/// the largest `overflow-y: auto|scroll|overlay` descendant (capped).
const KOMA_SCROLLABLE: &str = r#"
function komaScrollable(sel){
  if(sel){
    var el=document.querySelector(sel);
    if(el) return el;
  }
  var root=document.scrollingElement||document.documentElement||document.body;
  if(root && root.scrollHeight>root.clientHeight+1) return root;
  var best=root, bestOverflow=root?(root.scrollHeight-root.clientHeight):0;
  var nodes=document.querySelectorAll('*');
  var n=Math.min(nodes.length,500);
  for(var i=0;i<n;i++){
    var el=nodes[i];
    var oy=getComputedStyle(el).overflowY;
    if(oy!=='auto'&&oy!=='scroll'&&oy!=='overlay') continue;
    var overflow=el.scrollHeight-el.clientHeight;
    if(overflow>bestOverflow){ bestOverflow=overflow; best=el; }
  }
  return best||document.body;
}
"#;

/// Shared in-page helpers for click / hover / type / key / drag.
const KOMA_INPAGE: &str = r#"
function komaVisible(el){
  if(!el) return false;
  var r=el.getBoundingClientRect();
  if(r.width<1||r.height<1) return false;
  var s=getComputedStyle(el);
  if(s.visibility==='hidden'||s.display==='none'||s.opacity==='0') return false;
  return true;
}
function komaQuery(sel){
  var nodes;
  try { nodes=document.querySelectorAll(sel); }
  catch(e){ throw new Error('invalid CSS selector: '+sel); }
  if(!nodes||!nodes.length) throw new Error('not found');
  for(var i=0;i<nodes.length;i++){
    if(komaVisible(nodes[i])) return nodes[i];
  }
  return nodes[0];
}
function komaEl(sel,x,y){
  if(sel) return komaQuery(sel);
  var el=document.elementFromPoint(x,y);
  if(!el) throw new Error('no element');
  return el;
}
function komaPe(el,type,cx,cy,button,buttons){
  var init={bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy,button:button,buttons:buttons,pointerId:1,pointerType:'mouse',isPrimary:true};
  try { if(typeof PointerEvent==='function') el.dispatchEvent(new PointerEvent(type,init)); } catch(e) {}
  var mt=type==='pointerdown'?'mousedown':type==='pointerup'?'mouseup':type==='pointermove'?'mousemove':null;
  if(mt) try { el.dispatchEvent(new MouseEvent(mt,init)); } catch(e) {}
}
function komaPointer(el,type,x,y,button){
  if(!el) throw new Error('not found');
  if(type!=='move'&&type!=='up') el.scrollIntoView({block:'center'});
  var cx=x, cy=y;
  if(cx==null||cy==null||(typeof cx==='number'&&isNaN(cx))||(typeof cy==='number'&&isNaN(cy))){
    var r=el.getBoundingClientRect();
    cx=r.left+r.width/2;
    cy=r.top+r.height/2;
  }
  var btn=button||0;
  if(type==='hover'){
    komaPe(el,'pointermove',cx,cy,btn,0);
    try { el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy})); } catch(e) {}
    try { el.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy})); } catch(e) {}
    return;
  }
  if(type==='down'){ komaPe(el,'pointerdown',cx,cy,btn,1); return; }
  if(type==='up'){ komaPe(el,'pointerup',cx,cy,btn,0); return; }
  if(type==='move'){ komaPe(el,'pointermove',cx,cy,btn,1); return; }
  komaPe(el,'pointerdown',cx,cy,btn,1);
  komaPe(el,'pointerup',cx,cy,btn,0);
  if(type==='contextmenu'){
    try { el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy,button:2})); } catch(e) {}
    return;
  }
  try { el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy,button:btn})); } catch(e) {}
  if(typeof el.click==='function') el.click();
  if(type==='dblclick'){
    komaPe(el,'pointerdown',cx,cy,btn,1);
    komaPe(el,'pointerup',cx,cy,btn,0);
    try { el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy,button:btn})); } catch(e) {}
    try { el.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy,button:btn})); } catch(e) {}
  }
}
function komaType(el,text,append){
  if(!el) throw new Error('not found');
  el.focus();
  var proto=null;
  if(typeof HTMLInputElement==='function'&&el instanceof HTMLInputElement) proto=HTMLInputElement.prototype;
  else if(typeof HTMLTextAreaElement==='function'&&el instanceof HTMLTextAreaElement) proto=HTMLTextAreaElement.prototype;
  var desc=proto&&Object.getOwnPropertyDescriptor(proto,'value');
  if(desc&&desc.set){
    desc.set.call(el, append?String(el.value||'')+text:text);
  } else if('value' in el){
    el.value=append?String(el.value||'')+text:text;
  } else {
    try { document.execCommand('insertText',false,text); } catch(e) {}
  }
  try { el.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:text})); } catch(e) {}
  try { el.dispatchEvent(new InputEvent('input',{inputType:'insertText',data:text,bubbles:true})); } catch(e) {
    try { el.dispatchEvent(new Event('input',{bubbles:true})); } catch(e2) {}
  }
  try { el.dispatchEvent(new Event('change',{bubbles:true})); } catch(e) {}
}
function komaEnter(el){
  if(!el) el=document.activeElement||document.body;
  var opts={key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true};
  try { el.dispatchEvent(new KeyboardEvent('keydown',opts)); } catch(e) {}
  try { el.dispatchEvent(new KeyboardEvent('keyup',opts)); } catch(e) {}
  var form=el.closest&&el.closest('form');
  if(form&&typeof form.requestSubmit==='function'){
    try { form.requestSubmit(); return; } catch(e) {}
  }
  function visSubmit(root){
    if(!root||!root.querySelectorAll) return null;
    var cands=root.querySelectorAll('button[type=submit], input[type=submit]');
    for(var i=0;i<cands.length;i++){
      if(komaVisible(cands[i])) return cands[i];
    }
    return cands.length?cands[0]:null;
  }
  var sub=visSubmit(form)||visSubmit(document);
  if(sub&&typeof sub.click==='function'){ sub.click(); return; }
  var tag=(el.tagName||'').toUpperCase();
  var typ=(el.type||'').toLowerCase();
  if((tag==='BUTTON'||(tag==='INPUT'&&(typ==='submit'||typ==='button')))&&typeof el.click==='function'){
    el.click();
  }
}
"#;

pub(crate) fn action_js(action: &Action) -> Result<String> {
    match action {
        Action::Click {
            selector,
            x,
            y,
            button,
        } => click_js(selector.as_deref(), *x, *y, *button),
        Action::Dblclick { selector, x, y } => {
            click_js(selector.as_deref(), *x, *y, ClickButton::Double)
        }
        Action::Hover { selector, x, y } => hover_js(selector.as_deref(), *x, *y),
        Action::Scroll {
            selector,
            delta,
            to,
            ..
        } => Ok(scroll_js(selector.as_deref(), *delta, to.as_deref())),
        Action::Type { text, selector } => type_js(text, selector.as_deref()),
        Action::Key { keys } => Ok(key_js(keys.last().cloned().unwrap_or_default())),
        Action::Drag {
            selector,
            x,
            y,
            to_selector,
            to_x,
            to_y,
        } => drag_js(
            selector.as_deref(),
            *x,
            *y,
            to_selector.as_deref(),
            *to_x,
            *to_y,
        ),
        Action::Wait { .. } => bail!("wait is handled by the host, not JS"),
    }
}

fn click_js(
    selector: Option<&str>,
    x: Option<f64>,
    y: Option<f64>,
    button: ClickButton,
) -> Result<String> {
    reject_contains_opt(selector)?;
    if selector.is_none() && (x.is_none() || y.is_none()) {
        bail!("click needs selector or x,y");
    }
    let (kind, btn) = match button {
        ClickButton::Right => ("contextmenu", 2),
        ClickButton::Double => ("dblclick", 0),
        _ => ("click", 0),
    };
    let sel = js_str_or_null(selector);
    let x = js_num_or_null(x);
    let y = js_num_or_null(y);
    Ok(format!(
        r#"(function(){{ {KOMA_INPAGE}
          var el=komaEl({sel},{x},{y});
          komaPointer(el,{kind:?},{x},{y},{btn});
        }})();"#
    ))
}

fn hover_js(selector: Option<&str>, x: Option<f64>, y: Option<f64>) -> Result<String> {
    reject_contains_opt(selector)?;
    let sel = js_str_or_null(selector);
    let x = js_num_or_null(x.or_else(|| selector.is_none().then_some(0.0)));
    let y = js_num_or_null(y.or_else(|| selector.is_none().then_some(0.0)));
    Ok(format!(
        r#"(function(){{ {KOMA_INPAGE}
          var el=komaEl({sel},{x},{y});
          komaPointer(el,'hover',{x},{y},0);
        }})();"#
    ))
}

fn type_js(text: &str, selector: Option<&str>) -> Result<String> {
    reject_contains_opt(selector)?;
    let sel = js_str_or_null(selector);
    let append = selector.is_none();
    Ok(format!(
        r#"(function(){{ {KOMA_INPAGE}
          var el={sel}?komaQuery({sel}):(document.activeElement||null);
          if(!el) throw new Error({sel}?'not found':'no focus');
          komaType(el,{text:?},{append});
        }})();"#
    ))
}

fn drag_js(
    selector: Option<&str>,
    x: Option<f64>,
    y: Option<f64>,
    to_selector: Option<&str>,
    to_x: Option<f64>,
    to_y: Option<f64>,
) -> Result<String> {
    reject_contains_opt(selector)?;
    reject_contains_opt(to_selector)?;
    let start_ok = selector.is_some() || (x.is_some() && y.is_some());
    let end_ok = to_selector.is_some() || (to_x.is_some() && to_y.is_some());
    if !start_ok || !end_ok {
        bail!("drag needs start (selector or x,y) and end (to_selector or to_x,to_y)");
    }
    let sel = js_str_or_null(selector);
    let to_sel = js_str_or_null(to_selector);
    let x = js_num_or_null(x);
    let y = js_num_or_null(y);
    let to_x = js_num_or_null(to_x);
    let to_y = js_num_or_null(to_y);
    Ok(format!(
        r#"(function(){{ {KOMA_INPAGE}
          var start=komaEl({sel},{x},{y});
          var end=komaEl({to_sel},{to_x},{to_y});
          var r0=start.getBoundingClientRect();
          var r1=end.getBoundingClientRect();
          var x0=({x}!=null)?{x}:(r0.left+r0.width/2);
          var y0=({y}!=null)?{y}:(r0.top+r0.height/2);
          var x1=({to_x}!=null)?{to_x}:(r1.left+r1.width/2);
          var y1=({to_y}!=null)?{to_y}:(r1.top+r1.height/2);
          komaPointer(start,'down',x0,y0,0);
          var steps=5;
          for(var i=1;i<=steps;i++){{
            var t=i/steps;
            var mx=x0+(x1-x0)*t, my=y0+(y1-y0)*t;
            var mid=document.elementFromPoint(mx,my)||end;
            komaPointer(mid,'move',mx,my,0);
          }}
          komaPointer(end,'up',x1,y1,0);
        }})();"#
    ))
}

fn scroll_js(selector: Option<&str>, delta: Option<i32>, to: Option<&str>) -> String {
    let sel = js_str_or_null(selector);
    let to = js_str_or_null(to);
    let d = delta.unwrap_or(DEFAULT_DELTA_PX);
    format!(
        r#"(function(){{ {KOMA_SCROLLABLE}
          var to={to};
          if(to){{
            var dest=String(to).toLowerCase();
            if(dest==='bottom'||dest==='top'){{
              var el=komaScrollable({sel});
              if(!el) return;
              if(dest==='bottom') el.scrollTo(0, el.scrollHeight);
              else el.scrollTo(0, 0);
              return;
            }}
            var t=document.querySelector(to);
            if(t) t.scrollIntoView({{block:'center'}});
            return;
          }}
          var el=komaScrollable({sel});
          if(el) el.scrollBy(0, {d});
        }})();"#
    )
}

fn key_js(key: String) -> String {
    format!(
        r#"(function(){{ {KOMA_SCROLLABLE}
          {KOMA_INPAGE}
          var key={key:?};
          var kl=String(key).toLowerCase();
          if(kl==='enter'||kl==='numpadenter'){{
            komaEnter(document.activeElement||document.body);
            return;
          }}
          if(kl==='end'||kl==='home'||kl==='pagedown'||kl==='pageup'||kl===' '||kl==='space'||kl==='spacebar'||kl==='arrowdown'||kl==='arrowup'){{
            var el=komaScrollable(null);
            if(!el) return;
            var h=el.clientHeight||window.innerHeight||400;
            if(kl==='end') el.scrollTo(0, el.scrollHeight);
            else if(kl==='home') el.scrollTo(0, 0);
            else if(kl==='pagedown'||kl===' '||kl==='space'||kl==='spacebar') el.scrollBy(0, h);
            else if(kl==='pageup') el.scrollBy(0, -h);
            else if(kl==='arrowdown') el.scrollBy(0, 40);
            else if(kl==='arrowup') el.scrollBy(0, -40);
            return;
          }}
          var el=document.activeElement||document.body;
          el.dispatchEvent(new KeyboardEvent('keydown',{{key:key,bubbles:true}}));
          el.dispatchEvent(new KeyboardEvent('keyup',{{key:key,bubbles:true}}));
        }})();"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wait_is_delay_empty_vs_selector_vs_url_contains() {
        assert!(wait_is_delay(&None, &None));
        assert!(wait_is_delay(&Some(String::new()), &None));
        assert!(wait_is_delay(&None, &Some(String::new())));
        assert!(!wait_is_delay(&Some("#x".into()), &None));
        assert!(!wait_is_delay(&None, &Some("foo".into())));
        assert!(!wait_is_delay(&Some("#x".into()), &Some("foo".into())));
    }

    fn js(action: Action) -> String {
        action_js(&action).expect("action_js")
    }

    #[test]
    fn key_end_scrolls_via_scroll_height() {
        let s = js(Action::Key {
            keys: vec!["End".into()],
        });
        assert!(s.contains("scrollHeight"), "{s}");
        assert!(s.contains("overflowY"), "{s}");
    }

    #[test]
    fn scroll_to_bottom_uses_scroll_to() {
        let s = js(Action::Scroll {
            selector: None,
            x: None,
            y: None,
            delta: None,
            to: Some("bottom".into()),
        });
        assert!(s.contains("bottom"), "{s}");
        assert!(s.contains("scrollTo"), "{s}");
        assert!(s.contains("scrollHeight"), "{s}");
        assert!(s.contains("overflowY"), "{s}");
    }

    #[test]
    fn scroll_delta_is_pixels_not_notches() {
        let s = js(Action::Scroll {
            selector: None,
            x: None,
            y: None,
            delta: Some(4000),
            to: None,
        });
        assert!(s.contains("4000"), "{s}");
        assert!(!s.contains("160000"), "{s}");
        assert!(!s.contains("* 40") && !s.contains("*40"), "{s}");
        assert!(s.contains("overflowY"), "{s}");
    }

    #[test]
    fn wait_is_not_js() {
        assert!(action_js(&Action::Wait {
            selector: None,
            url_contains: None,
            timeout_ms: Some(800),
        })
        .is_err());
    }

    #[test]
    fn coordinate_click_uses_pointer_and_el_click() {
        let s = js(Action::Click {
            selector: None,
            x: Some(10.0),
            y: Some(20.0),
            button: ClickButton::Left,
        });
        assert!(s.contains("pointerdown"), "{s}");
        assert!(s.contains("el.click"), "{s}");
    }

    #[test]
    fn selector_click_uses_pointer_and_el_click() {
        let s = js(Action::Click {
            selector: Some("button.q".into()),
            x: None,
            y: None,
            button: ClickButton::Left,
        });
        assert!(s.contains("pointerdown"), "{s}");
        assert!(s.contains("el.click"), "{s}");
        assert!(s.contains("komaQuery"), "{s}");
    }

    #[test]
    fn type_uses_insert_text_and_native_setter() {
        let s = js(Action::Type {
            text: "zonblade".into(),
            selector: Some("textarea[name=q]".into()),
        });
        assert!(s.contains("insertText"), "{s}");
        assert!(s.contains("HTMLInputElement.prototype"), "{s}");
    }

    #[test]
    fn enter_uses_request_submit() {
        let s = js(Action::Key {
            keys: vec!["Enter".into()],
        });
        assert!(s.contains("requestSubmit"), "{s}");
        assert!(!s.contains("scrollBy(0, h)") || s.contains("komaEnter"), "{s}");
    }

    #[test]
    fn contains_selector_rejected_in_rust() {
        let err = action_js(&Action::Click {
            selector: Some("button:contains('Google')".into()),
            x: None,
            y: None,
            button: ClickButton::Left,
        })
        .unwrap_err()
        .to_string();
        assert!(err.contains(":contains"), "{err}");
        assert!(err.contains("invalid CSS selector"), "{err}");
    }

    #[test]
    fn drag_js_contains_pointer_down_and_up() {
        let s = js(Action::Drag {
            selector: Some("#a".into()),
            x: None,
            y: None,
            to_selector: Some("#b".into()),
            to_x: None,
            to_y: None,
        });
        assert!(s.contains("pointerdown"), "{s}");
        assert!(s.contains("pointerup"), "{s}");
    }

    #[test]
    fn drag_requires_start_and_end() {
        assert!(action_js(&Action::Drag {
            selector: None,
            x: None,
            y: None,
            to_selector: Some("#b".into()),
            to_x: None,
            to_y: None,
        })
        .is_err());
    }
}
