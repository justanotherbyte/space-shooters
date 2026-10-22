// The connection to the room's ArenaAgent, over the Agents SDK client.
// AgentClient (a PartySocket) reconnects on its own; every (re)open sends
// `join` and the server answers with a full `welcome` to resync from.
import { AgentClient } from "agents/client";
import { PROTOCOL } from "./protocol";
import type { Checkpoint, ClientMessage, Snapshot, Welcome } from "./protocol";

export interface NetHandlers {
  welcome(w: Welcome): void;
  snapshot(s: Snapshot): void;
  checkpoint(c: Checkpoint): void;
  link(up: boolean): void;
  error(code: string): void;
}

export class Net {
  client: AgentClient<unknown, Checkpoint>;
  rtt = 0;
  up = false;

  constructor(public room: string, public pid: string, h: NetHandlers) {
    this.client = new AgentClient<unknown, Checkpoint>({
      agent: "arena-agent",
      name: room,
      host: location.host,
      onStateUpdate: (state) => h.checkpoint(state),
    });
    this.client.addEventListener("open", () => {
      this.up = true;
      this.send({ t: "join", v: PROTOCOL, pid: this.pid });
      h.link(true);
    });
    this.client.addEventListener("close", () => {
      this.up = false;
      h.link(false);
    });
    this.client.addEventListener("message", (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      const msg = JSON.parse(e.data);
      if (msg.t === "s") h.snapshot(msg);
      else if (msg.t === "welcome") h.welcome(msg);
      else if (msg.t === "pong") this.rtt = this.rtt ? this.rtt * 0.7 + (performance.now() - msg.c) * 0.3 : performance.now() - msg.c;
      else if (msg.t === "error") h.error(msg.code);
    });
    setInterval(() => this.send({ t: "ping", c: performance.now() }), 1000);
  }

  send(m: ClientMessage) {
    if (this.up) this.client.send(JSON.stringify(m));
  }
}
