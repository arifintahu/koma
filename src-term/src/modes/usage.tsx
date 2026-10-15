import { useEffect, useState } from "react"
import { useRenderer } from "@opentui/react"
import type { Theme } from "../theme.ts"
import { Document } from "./bits.tsx"
import { num, rec, rows, str, type Rec } from "./read.ts"

const BARS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]

export function money(value: number): string {
  if (!Number.isFinite(value)) return "$0.0000"
  if (Math.abs(value) >= 100) return `$${value.toFixed(2)}`
  return `$${value.toFixed(4)}`
}

export function groupInt(value: number): string {
  const n = Math.round(value)
  const sign = n < 0 ? "-" : ""
  return sign + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

export function pct(part: number, whole: number): string {
  if (!(whole > 0)) return "0.0%"
  return `${((part / whole) * 100).toFixed(1)}%`
}

/** Sum a long ledger into the columns that fit the screen, keeping time order. */
export function fitSeries(values: number[], epochs: number[], maxCols: number): { values: number[]; epochs: number[] } {
  const cols = Math.max(1, maxCols)
  if (values.length <= cols) return { values, epochs }
  const outValues: number[] = []
  const outEpochs: number[] = []
  for (let i = 0; i < cols; i++) {
    const start = Math.floor((i * values.length) / cols)
    const end = Math.floor(((i + 1) * values.length) / cols)
    let sum = 0
    for (let j = start; j < end; j++) sum += values[j] ?? 0
    outValues.push(sum)
    outEpochs.push(epochs[start] ?? 0)
  }
  return { values: outValues, epochs: outEpochs }
}

/** One glyph per column, from the top row down. The tallest value is a full bar. */
export function chartCells(values: number[], rows: number): string[][] {
  const height = Math.max(1, rows)
  const max = Math.max(0, ...values)
  return values.map((value) => {
    const filled = max <= 0 || value <= 0 ? 0 : Math.max(1, Math.round((value / max) * height))
    return Array.from({ length: height }, (_, row) => (height - 1 - row < filled ? "█" : " "))
  })
}

export function UsageBoard({ body, theme }: { body: Rec; theme: Theme }) {
  const width = useWidth()
  const height = useHeight()
  const data = rec(body.data)
  const session = body.view === "session"
  const metric = body.metric === "tokens" ? "tokens" : "cost"
  const range = str(body.range) || "today"
  const models = rows(session ? data.session_models : data.top_models)
  const heat = rows(session ? data.session_hourly : data.heatmap_buckets)
  const totals = session
    ? body.session_totals
      ? rec(body.session_totals)
      : {
          cost: models.reduce((sum, row) => sum + num(row.total_cost), 0),
          calls: num(data.session_calls),
          tokens_in: models.reduce((sum, row) => sum + num(row.tokens_in), 0),
          tokens_cached: models.reduce((sum, row) => sum + num(row.tokens_cached), 0),
          tokens_out: models.reduce((sum, row) => sum + num(row.tokens_out), 0),
        }
    : rec(data.totals)
  const role = rec(data.role_split)
  const cost = num(totals.cost)
  const calls = num(totals.calls)
  const tokensIn = num(totals.tokens_in)
  const tokensOut = num(totals.tokens_out)
  const cached = num(totals.tokens_cached)
  const values = heat.map((bucket) => num(bucket[metric]))
  const epochs = heat.map((bucket) => num(bucket.bucket_epoch))
  const chartWidth = Math.max(12, width - 6)
  const series = fitSeries(values, epochs, chartWidth)
  const chartHeight = height >= 42 ? 10 : height >= 30 ? 8 : 5
  const cells = chartCells(series.values, chartHeight)
  const max = Math.max(0, ...series.values)
  const peakAt = series.values.reduce((best, value, index) => (value > (series.values[best] ?? -1) ? index : best), 0)
  const active = values.filter((value) => value > 0)
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
  const modelCost = models.reduce((sum, row) => sum + num(row.total_cost), 0)
  const mainCost = num(role.main_cost)
  const subCost = num(role.sub_cost)
  const roleTotal = mainCost + subCost
  const barWidth = Math.max(10, Math.min(36, width - 28))
  const mainWidth = roleTotal > 0 ? Math.round((mainCost / roleTotal) * barWidth) : 0

  return (
    <box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0} gap={1}>
      <box flexShrink={0} flexDirection="row" justifyContent="space-between">
        <text>
          {["today", "week", "year"].map((name) => name === range
            ? <span key={name} fg={theme.selFg} bg={theme.selBg}>{` ${name} `}</span>
            : <span key={name} fg={theme.dim}>{` ${name} `}</span>)}
          <span fg={theme.dim}>{session ? "   session ledger" : "   global ledger"}</span>
        </text>
        <text fg={theme.accent}>{`metric ${metric}`}</text>
      </box>
      <box flexShrink={0} flexDirection="row" flexWrap="wrap" gap={1}>
        <Stat label="COST" value={money(cost)} hint={`${money(calls ? cost / calls : 0)} / call`} theme={theme} color={theme.accent} />
        <Stat label="CALLS" value={groupInt(calls)} hint={`${groupInt(active.length)} active buckets`} theme={theme} color={theme.fg} />
        <Stat label="IN" value={groupInt(tokensIn)} hint={`${money(tokensIn ? cost / (tokensIn / 1_000_000) : 0)} / 1M`} theme={theme} color={theme.info} />
        <Stat label="CACHED" value={groupInt(cached)} hint={`${pct(cached, tokensIn)} of input`} theme={theme} color={theme.success} />
        <Stat label="OUT" value={groupInt(tokensOut)} hint={`${pct(tokensOut, tokensIn)} of input`} theme={theme} color={theme.warn} />
      </box>
      <box flexShrink={0} flexDirection="column">
        <text>
          <span fg={theme.accent}>{session ? "SESSION ACTIVITY" : range === "today" ? "HOURLY" : range === "week" ? "DAILY" : "RANGE"}</span>
          <span fg={theme.dim}>{`  ${metric}  peak ${formatMetric(series.values[peakAt] ?? 0, metric)}`}</span>
        </text>
        {series.values.length ? cells.map((row, rowIndex) => (
          <text key={rowIndex} wrapMode="none">
            {row.map((cell, index) => <span key={index} fg={heatColor(series.values[index] ?? 0, max, theme)}>{cell}</span>)}
          </text>
        )) : <text fg={theme.dim}>No activity recorded in this range.</text>}
        {series.epochs.length ? <text fg={theme.dim} wrapMode="none">{axisLine(series.epochs, range, series.values.length)}</text> : null}
        <text fg={theme.dim}>{`avg ${formatMetric(average, metric)} · peak ${stamp(epochs[values.indexOf(Math.max(0, ...values))] ?? series.epochs[peakAt] ?? 0, range)} · ${heat.length ? `${stamp(epochs[0] ?? 0, "day")} – ${stamp(epochs[epochs.length - 1] ?? 0, "day")}` : "no span"}`}</text>
        <text>
          <span fg={theme.dim}>less </span>
          {theme.heat.map((color, index) => <span key={index} fg={color}>{BARS[2 + index] ?? "█"}</span>)}
          <span fg={theme.dim}>{` more · ${metric === "tokens" ? `${groupInt(heat.reduce((sum, bucket) => sum + num(bucket.tokens), 0))} tokens` : money(heat.reduce((sum, bucket) => sum + num(bucket.cost), 0))}`}</span>
        </text>
      </box>
      <Document>
        <text fg={theme.accent}>{`MODELS  ${models.length}`}</text>
        {models.length ? models.map((row, index) => {
          const modelCostValue = num(row.total_cost)
          const share = modelCost > 0 ? modelCostValue / modelCost : 0
          const shareWidth = Math.round(share * Math.min(24, barWidth))
          return (
            <box key={`${str(row.model_id)}-${index}`} flexDirection="column" flexShrink={0}>
              <text wrapMode="none">
                <span fg={theme.dim}>{`${String(index + 1).padStart(2, " ")} `}</span>
                <span fg={theme.fg}>{clipName(str(row.model_id), Math.max(12, width > 100 ? 32 : 18))}</span>
                <span fg={theme.accent}>{`  ${money(modelCostValue)}`}</span>
                <span fg={theme.info}>{`  ${pct(modelCostValue, modelCost)}`}</span>
                <span fg={theme.dim}>{`  ${groupInt(num(row.call_count))} calls  ${money(num(row.call_count) ? modelCostValue / num(row.call_count) : 0)}/call`}</span>
              </text>
              <text wrapMode="none">
                <span fg={theme.accent}>{"█".repeat(shareWidth).padEnd(Math.min(24, barWidth), "·")}</span>
                <span fg={theme.info}>{` ${groupInt(num(row.tokens_in))} in`}</span>
                <span fg={theme.success}>{`  ${groupInt(num(row.tokens_cached))} cached`}</span>
                <span fg={theme.warn}>{`  ${groupInt(num(row.tokens_out))} out`}</span>
              </text>
            </box>
          )
        }) : <text fg={theme.dim}>No model usage recorded in this range.</text>}
        {!session ? (
          <box flexDirection="column" flexShrink={0}>
            <text fg={theme.accent}>ROLE SPLIT</text>
            <text wrapMode="none">
              <span fg={theme.info}>{"█".repeat(mainWidth)}</span>
              <span fg={theme.success}>{"█".repeat(Math.max(0, barWidth - mainWidth))}</span>
            </text>
            <text>
              <span fg={theme.info}>{`Main ${money(mainCost)} · ${groupInt(num(role.main_calls))} calls · ${pct(mainCost, roleTotal)}`}</span>
              <span fg={theme.dim}>{"   "}</span>
              <span fg={theme.success}>{`Subagents ${money(subCost)} · ${groupInt(num(role.sub_calls))} calls · ${pct(subCost, roleTotal)}`}</span>
            </text>
          </box>
        ) : null}
      </Document>
    </box>
  )
}

function Stat({ label, value, hint, theme, color }: { label: string; value: string; hint: string; theme: Theme; color: string }) {
  return (
    <box width={22} height={5} flexShrink={0} border borderStyle="rounded" borderColor={theme.dim} paddingLeft={1} paddingRight={1} flexDirection="column">
      <text fg={theme.dim}>{label}</text>
      <text fg={color} wrapMode="none">{value}</text>
      <text fg={theme.dim} wrapMode="none">{hint}</text>
    </box>
  )
}

function heatColor(value: number, max: number, theme: Theme): string {
  if (!(max > 0) || value <= 0) return theme.heat[0]
  const step = Math.min(theme.heat.length - 1, Math.ceil((value / max) * (theme.heat.length - 1)))
  return theme.heat[step] ?? theme.accent
}

function formatMetric(value: number, metric: string): string {
  return metric === "tokens" ? groupInt(value) : money(value)
}

function stamp(epoch: number, range: string): string {
  if (!epoch) return "—"
  const date = new Date(epoch * 1000)
  if (range === "today") return `${String(date.getHours()).padStart(2, "0")}:00`
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return range === "day" ? `${date.getFullYear()}-${month}-${day}` : `${month}-${day}`
}

function axisLine(epochs: number[], range: string, columns: number): string {
  if (!epochs.length || columns <= 0) return ""
  const marks = [0, Math.floor((epochs.length - 1) / 2), epochs.length - 1]
  const labels = marks.map((index) => stamp(epochs[index] ?? 0, range))
  if (columns < 12) return labels[0] ?? ""
  const left = labels[0] ?? ""
  const mid = labels[1] ?? ""
  const right = labels[2] ?? ""
  const gap = Math.max(1, Math.floor((columns - left.length - mid.length - right.length) / 2))
  return `${left}${" ".repeat(gap)}${mid}${" ".repeat(gap)}${right}`
}

function clipName(value: string, max: number): string {
  if ([...value].length <= max) return value
  return `${[...value].slice(0, Math.max(1, max - 1)).join("")}…`
}

function useWidth(): number {
  const renderer = useRenderer()
  const [width, setWidth] = useState(renderer.width)
  useEffect(() => {
    const read = () => setWidth((current) => current === renderer.width ? current : renderer.width)
    renderer.on("frame", read)
    return () => { renderer.off("frame", read) }
  }, [renderer])
  return width
}

function useHeight(): number {
  const renderer = useRenderer()
  const [height, setHeight] = useState(renderer.height)
  useEffect(() => {
    const read = () => setHeight((current) => current === renderer.height ? current : renderer.height)
    renderer.on("frame", read)
    return () => { renderer.off("frame", read) }
  }, [renderer])
  return height
}
