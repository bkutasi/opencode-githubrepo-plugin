import { search } from "./index.ts"
const token = process.env.GH_TOKEN || ""
const ac = new AbortController()
try {
  const r = await search("lkonga", "ocsearchv2", "register Command Code account", token, ac.signal, ["sessions"])
  console.log("RESULTS:", r.length)
  for (const x of r.slice(0,8)) console.log(" ", (x as any).path ?? JSON.stringify(x).slice(0,140))
} catch (e) { console.log("ERROR:", String(e).slice(0,500)) }
