import { Glob } from "bun";
import { resolve } from "path";

const MRS_DIRS = [
  "./meta-rules-dat-meta/geo/geosite",
  "./meta-rules-dat-meta/geo/geoip",
];
const TEST_URL = "http://cp.cloudflare.com";
const START_PORT = 20000;
const CONCURRENCY_LIMIT = 20; // Limit how many tests run at once

async function findFiles() {
  const glob = new Glob("**/*.mrs");
  const files = [];
  for (const dir of MRS_DIRS) {
    for await (const file of glob.scan(dir)) {
      files.push(resolve(process.cwd(), dir, file));
    }
  }
  return files;
}

function generateConfig(listenPort, behavior, mrsFilePath) {
  const config = `
mixed-port: ${listenPort}
mode: rule
log-level: info
allow-lan: false
profile:
  store-selected: false
  store-fake-ip: false
proxies:
  - name: direct1
    type: direct
    ip-version: ipv4-prefer
rules:
  - RULE-SET,geo_rules,direct1
  - MATCH,DIRECT
rule-providers:
  geo_rules:
    type: file
    behavior: ${behavior}
    format: mrs
    path: "${mrsFilePath}"
    interval: 3000
  `;
  return Buffer.from(config).toString("base64");
}

async function testMrsFile(filePath, port) {
  const behavior = filePath.includes("/geosite/") ? "domain" : "ipcidr";
  console.log(`--- Testing ${filePath} on port ${port} (behavior: ${behavior}) ---`);

  const encodedConfig = generateConfig(port, behavior, filePath);
  const mihomoProcess = Bun.spawn({
    cmd: ["mihomo", "-config", encodedConfig],
    env: { ...process.env, SAFE_PATHS: process.cwd() },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10000, // 10 seconds timeout for mihomo process
    onExit(proc, exitCode, signalCode, error) {
        if (exitCode !== 0 && exitCode !== null) {
            console.error(`mihomo process exited with code ${exitCode}`);
        } else if (signalCode !== null) {
            console.error(`mihomo process killed by signal ${signalCode}`);
        } else if (error) {
            console.error(`mihomo process error: ${error.message}`);
        }
    }
  });

  let result = { success: false, log: "", filePath };
  let startupError = null;

  try {
    // Wait for mihomo to indicate it's listening by checking logs
    // We cannot use proc.exited here as we need to test the proxy while it's running.
    // Instead, we wait a fixed short period and then try to connect.
    // If we want to be more precise, we would need to continuously read stderr/stdout
    // and check for the "listening" message, but the user wanted less complexity.
    // For now, a short sleep (e.g., 2 seconds) will be used to allow mihomo to start.
    await Bun.sleep(2000); // Wait 2 seconds for mihomo to start

    const response = await fetch(TEST_URL, {
      proxy: `http://127.0.0.1:${port}`,
    });

    if (response.status === 200 || response.status === 204) {
      console.log(`RESULT: SUCCESS (HTTP ${response.status}) for ${filePath}`);
      result.success = true;
    } else {
      console.error(`RESULT: FAILURE (HTTP ${response.status}) for ${filePath}`);
    }
  } catch (error) {
    console.error(`RESULT: FAILURE (Fetch/Startup Error) for ${filePath}:`, error.message);
    startupError = error;
  } finally {
    mihomoProcess.kill(); // Ensure mihomo process is killed
  }
  
  // Wait for the process to fully exit and capture logs
  await mihomoProcess.exited;

  const stdout = await Bun.readableStreamToText(mihomoProcess.stdout);
  const stderr = await Bun.readableStreamToText(mihomoProcess.stderr);
  
  // If there was a startup error (e.g., timeout or fetch failed early), include it in the log
  if (startupError && !result.log) {
    result.log = `--- Startup/Fetch Error ---\n${startupError.message}\n\n`;
  }
  result.log += `--- STDOUT ---\n${stdout}\n\n--- STDERR ---\n${stderr}`;

  return result;
}

async function main() {
  const files = await findFiles();
  if (files.length === 0) {
    console.error("No .mrs files found.");
    process.exit(1);
  }

  console.log(`Found ${files.length} .mrs files. Starting tests with concurrency ${CONCURRENCY_LIMIT}...`);

  const taskIterator = files[Symbol.iterator]();
  const results = [];

  const worker = async (workerId) => {
    const port = START_PORT + workerId;
    for (const filePath of taskIterator) {
      // The iterator is shared, so multiple workers will pull from it concurrently.
      if (!filePath) continue;
      const res = await testMrsFile(filePath, port);
      results.push(res);
    }
  };

  const workerPromises = Array.from({ length: CONCURRENCY_LIMIT }, (_, i) => worker(i));
  await Promise.all(workerPromises);

  console.log("\n--- Test Summary ---");
  const failedTests = results.filter(r => !r.success);

  if (failedTests.length > 0) {
    console.error(`\n${failedTests.length} of ${files.length} tests failed.`);
    for (const failure of failedTests) {
      console.error(`\n--- Failure Log for: ${failure.filePath} ---`);
      console.error(failure.log);
      console.error("--------------------------------------------------\n");
    }
    process.exit(1);
  } else {
    console.log(`\nAll ${files.length} tests passed successfully!`);
  }
}

main();
