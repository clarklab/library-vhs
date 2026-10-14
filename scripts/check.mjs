import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const walk = async (dir) =>
  (
    await Promise.all(
      (await readdir(dir, { withFileTypes: true })).map((entry) =>
        entry.isDirectory()
          ? walk(`${dir}/${entry.name}`)
          : [`${dir}/${entry.name}`],
      ),
    )
  ).flat();
const files = (await Promise.all(["public/js", "netlify", "scripts"].map(walk)))
  .flat()
  .filter((file) => /\.(m?js)$/.test(file));
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit",
  });
  if (result.status) process.exit(result.status);
}
console.log(`Syntax checked ${files.length} JavaScript modules.`);
