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
        Action::Hover { selector, x, y } => {
            if let Some(sel) = selector {
                Ok(format!(
                    r#"(function(){{const el=document.querySelector({sel:?}); if(!el) throw new Error('not found'); el.dispatchEvent(new MouseEvent('mouseover',{{bubbles:true}})); el.dispatchEvent(new MouseEvent('mouseenter',{{bubbles:true}}));}})();"#
                ))
            } else {
                let x = x.unwrap_or(0.0);
                let y = y.unwrap_or(0.0);
                Ok(format!(
                    r#"(function(){{const el=document.elementFromPoint({x},{y}); if(el){{el.dispatchEvent(new MouseEvent('mouseover',{{bubbles:true,clientX:{x},clientY:{y}}}));}}}})();"#
                ))
            }
        }
        Action::Scroll {
            selector,
            delta,
            to,
            ..
        } => Ok(scroll_js(selector.as_deref(), *delta, to.as_deref())),
        Action::Type { text, selector } => {
            let t = text.replace('\\', "\\\\").replace('\'', "\\'");
            if let Some(sel) = selector {
                Ok(format!(
                    r#"(function(){{const el=document.querySelector({sel:?}); if(!el) throw new Error('not found'); el.focus(); el.value='{t}'; el.dispatchEvent(new Event('input',{{bubbles:true}})); el.dispatchEvent(new Event('change',{{bubbles:true}}));}})();"#
                ))
            } else {
                Ok(format!(
                    r#"(function(){{const el=document.activeElement; if(!el) throw new Error('no focus'); if('value' in el){{el.value=(el.value||'')+'{t}'; el.dispatchEvent(new Event('input',{{bubbles:true}}));}} else {{document.execCommand('insertText',false,'{t}');}}}})();"#
                ))
            }
        }
        Action::Key { keys } => Ok(key_js(keys.last().cloned().unwrap_or_default())),
        Action::Wait { .. } => bail!("wait is handled by the host, not JS"),
    }
}

fn click_js(
    selector: Option<&str>,
    x: Option<f64>,
    y: Option<f64>,
    button: ClickButton,
) -> Result<String> {
    let btn = match button {
        ClickButton::Right => "contextmenu",
        ClickButton::Double => "dblclick",
        _ => "click",
    };
    if let Some(sel) = selector {
        Ok(format!(
            r#"(function(){{const el=document.querySelector({sel:?}); if(!el) throw new Error('not found'); el.scrollIntoView({{block:'center'}}); el.dispatchEvent(new MouseEvent('{btn}',{{bubbles:true,cancelable:true,view:window}})); if({btn:?}==='click'&&typeof el.click==='function') el.click();}})();"#
        ))
    } else {
        let x = x.ok_or_else(|| anyhow::anyhow!("click needs selector or x,y"))?;
        let y = y.ok_or_else(|| anyhow::anyhow!("click needs selector or x,y"))?;
        Ok(format!(
            r#"(function(){{const el=document.elementFromPoint({x},{y}); if(!el) throw new Error('no element'); el.dispatchEvent(new MouseEvent('{btn}',{{bubbles:true,cancelable:true,clientX:{x},clientY:{y},view:window}}));}})();"#
        ))
    }
}

fn js_str_or_null(s: Option<&str>) -> String {
    match s {
        Some(s) => format!("{s:?}"),
        None => "null".into(),
    }
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
          var key={key:?};
          var kl=String(key).toLowerCase();
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
}
