import { execFileSync } from "node:child_process";

if (process.env.SHARED_VDS_SKIP_BEFORE_BUILD === "1") {
  console.log("Skipping Tauri beforeBuildCommand because SHARED_VDS_SKIP_BEFORE_BUILD=1");
  process.exit(0);
}

execFileSync("bun", ["run", "build"], { stdio: "inherit" });
