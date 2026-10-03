// handleSummary helper: JSON summary to load/results/ plus a short stdout table.
import { CONFIG } from "../config.js";

const TREND_KEYS = ["avg", "med", "p(90)", "p(95)", "p(99)", "max"];

function fmt(n) {
  return typeof n === "number" ? (Math.round(n * 100) / 100).toString() : "-";
}

function line(name, metric) {
  if (!metric) return `${name}: no samples`;
  const v = metric.values;
  if (metric.type === "trend") {
    return `${name}: ${TREND_KEYS.map((k) => `${k}=${fmt(v[k])}ms`).join(" ")}`;
  }
  if (metric.type === "rate") return `${name}: ${fmt(v.rate * 100)}% (${v.passes}/${v.passes + v.fails})`;
  if (metric.type === "counter") return `${name}: ${v.count} (${fmt(v.rate)}/s)`;
  if (metric.type === "gauge") return `${name}: ${v.value} (max ${v.max})`;
  return `${name}: ${JSON.stringify(v)}`;
}

function thresholdResults(metrics) {
  const out = {};
  for (const [name, metric] of Object.entries(metrics)) {
    if (!metric.thresholds) continue;
    out[name] = Object.fromEntries(
      Object.entries(metric.thresholds).map(([expr, r]) => [expr, r.ok]),
    );
  }
  return out;
}

export function makeSummary(script, extraMetrics = []) {
  return (data) => {
    const finishedAt = new Date().toISOString();
    const thresholds = thresholdResults(data.metrics);
    const passed = Object.values(thresholds).every((t) => Object.values(t).every(Boolean));
    const report = {
      script,
      finishedAt,
      passed,
      config: CONFIG,
      testRunDurationMs: data.state.testRunDurationMs,
      thresholds,
      checks: (data.root_group.checks || []).map((c) => ({
        name: c.name,
        passes: c.passes,
        fails: c.fails,
      })),
      metrics: data.metrics,
    };
    const stamp = finishedAt.replace(/[:.]/g, "-");
    const file = `load/results/${script}-${CONFIG.rooms}r-${stamp}.json`;

    const names = [
      "mutation_latency",
      "query_latency",
      "mutations",
      "errors",
      "stale_rejections",
      ...extraMetrics,
      "active_rooms",
      "active_players",
      "iterations",
    ];
    const text = [
      "",
      `${script}: rooms=${CONFIG.rooms} players=${CONFIG.playersPerRoom} duration=${CONFIG.duration} thinkMs=${CONFIG.thinkMs}`,
      ...names.map((n) => `  ${line(n, data.metrics[n])}`),
      ...report.checks
        .filter((c) => c.fails > 0)
        .map((c) => `  failed check "${c.name}": ${c.fails}/${c.passes + c.fails}`),
      `  thresholds: ${passed ? "PASS" : "FAIL"} ${JSON.stringify(thresholds)}`,
      `  summary: ${file}`,
      "",
    ].join("\n");

    return { [file]: JSON.stringify(report, null, 2), stdout: text };
  };
}
