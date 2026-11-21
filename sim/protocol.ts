// WebSocket messages between browser and server (JSON).

export type ClientMsg =
  | { t: "ping"; c: number }
  | { t: "create" }
  | { t: "join"; code: string }
  | { t: "queue" }
  | { t: "leave" }
  | { t: "in"; f: number; i: number } // my input for frame f
  | { t: "rematch" };

export type ServerMsg =
  | { t: "pong"; c: number }
  | { t: "room"; code: string } // invite created, waiting for friend
  | { t: "waiting" } // in the random queue
  | { t: "start"; side: 0 | 1; code: string }
  | { t: "f"; f: number; a: number; b: number; l: number; h?: number } // confirmed inputs for frame f
  | { t: "rematch" } // opponent wants a rematch
  | { t: "left" } // opponent left
  | { t: "error"; msg: string };
