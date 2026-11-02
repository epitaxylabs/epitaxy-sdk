// Run a test plan on a real board and print the result (Node 18+).
//   export EPITAXY_API_KEY=fpu_...
//   node run-plan.mjs ../plans/blinky.json build/app.elf
//   node run-plan.mjs ../try-it/plan.json ../try-it/sim_fw/demo.json     # try it now (simulated station)
import { readFile } from "node:fs/promises";
import { Epitaxy } from "../../js/dist/index.js";   // or "@epitaxy/client" once installed from npm

const [planPath, firmware] = process.argv.slice(2);
const plan = JSON.parse(await readFile(planPath, "utf8"));
const imageName = Object.values(plan.images)[0].file;

const ep = new Epitaxy();
const v = await ep.validate(plan);
if (!v.runnable) { console.error("no board can run this plan:", v); process.exit(2); }
const job = await ep.submit(plan, { files: { [imageName]: await readFile(firmware) }, waitS: 300 });
console.log(job.summary || job.raw);
process.exit(job.passed ? 0 : 1);
