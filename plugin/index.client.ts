import type { PluginClientContext } from "@getpaseo/plugin/client";
import { WAKE } from "./shared/rpc";

/** The only client part of SLP: wake the daemon side so its timer runs after a plugin reload (spec §7). It decides nothing. */
export default function contribute(client: PluginClientContext) {
  const wake = () => { void client.rpc(WAKE, {}).catch(() => undefined); };
  wake();
  const timer = setInterval(wake, 60_000);
  return () => clearInterval(timer);
}
