import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** The app calls this when it opens and every minute: a plugin reload leaves the daemon side without a Paseo client until the first hook (T21 row 24). */
export const WAKE = defineRpc({ name: "slp.wake", input: z.object({}), output: z.object({ ok: z.boolean() }) });
