/**
 * `obsidian agent:stop` (#415): stop an answer started with `agent:ask`. Ctrl+C ends the terminal but not the
 * answer, which runs on inside Obsidian (cli/ask.ts), and the terminal shows nothing while it runs. So each running
 * terminal answer is listed here under its conversation's name — the name its notice in Obsidian shows — and this
 * command stops one of them, or all.
 */

/** A terminal answer that is running: what agent:stop lists and stops. */
export interface RunningAsk {
  /** The conversation's name, as the notice in Obsidian says it. */
  session: string;
  prompt: string;
  agent: string;
  started: number;
  /** Stop the answer: agent:ask then prints what was said so far and that it was stopped. */
  stop(): void;
}

/** The terminal answers running now, by conversation name. agent:ask adds and removes its own. */
export class RunningAsks {
  private readonly running = new Map<string, RunningAsk>();

  add(entry: RunningAsk): () => void {
    this.running.set(entry.session, entry);
    return () => {
      if (this.running.get(entry.session) === entry) this.running.delete(entry.session);
    };
  }

  list(): RunningAsk[] {
    return [...this.running.values()].sort((a, b) => a.started - b.started);
  }

  get(session: string): RunningAsk | undefined {
    return this.running.get(session);
  }
}

export interface StopParams {
  /** The conversation whose answer to stop; every terminal answer when not given. */
  session?: string;
  /** "true": list the running answers instead. */
  list?: string;
  format?: string;
}

function line(entry: RunningAsk, now: number): string {
  const prompt = entry.prompt.replace(/\s+/g, " ").trim();
  const short = prompt.length > 60 ? `${prompt.slice(0, 59)}…` : prompt;
  return `${entry.session}  ${entry.agent}  ${Math.round((now - entry.started) / 1000)} s  "${short}"`;
}

/** Runs the command; never throws: a problem is a line starting with `Error:`, or `ok: false` in JSON. */
export function stop(asks: RunningAsks, params: StopParams, now = Date.now()): string {
  const json = params.format === "json";
  const running = asks.list();
  if (params.list !== undefined && params.list !== "false") {
    if (json) {
      return JSON.stringify({ ok: true, running: running.map((entry) => ({
        session: entry.session, agent: entry.agent, prompt: entry.prompt,
        seconds: Math.round((now - entry.started) / 1000) })) }, null, 2);
    }
    return running.length ? running.map((entry) => line(entry, now)).join("\n")
      : "No answer from the terminal is running.";
  }
  let chosen = running;
  if (params.session) {
    const entry = asks.get(params.session);
    if (!entry) {
      const error = `no answer from the terminal is running in '${params.session}'`
        + (running.length ? ` (running: ${running.map((one) => one.session).join(", ")})` : "");
      return json ? JSON.stringify({ ok: false, error, stopped: [] }, null, 2) : `Error: ${error}`;
    }
    chosen = [entry];
  }
  for (const entry of chosen) entry.stop();
  const sessions = chosen.map((entry) => entry.session);
  if (json) return JSON.stringify({ ok: true, stopped: sessions }, null, 2);
  if (!sessions.length) return "No answer from the terminal is running.";
  return `Stopped ${sessions.length === 1 ? "1 answer" : `${sessions.length} answers`}: ${sessions.join(", ")}. `
    + "agent:ask prints what was said so far.";
}
