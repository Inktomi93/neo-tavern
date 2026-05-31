import { EventEmitter } from "node:events";

export const chatStreamEmitter = new EventEmitter();
// One listener per active streamMessages subscription (per tab/device). The Node default of 10
// triggers MaxListenersExceededWarning once the user has more than that open at once. Lift the
// cap — this is a single-user app, listeners aren't a leak vector, and the noise hides real bugs.
chatStreamEmitter.setMaxListeners(0);
