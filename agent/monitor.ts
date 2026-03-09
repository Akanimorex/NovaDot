import { ethers, JsonRpcProvider, Wallet, Contract, formatUnits } from "ethers";
import * as dotenv from "dotenv";
import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";

dotenv.config({ path: path.join(__dirname, "../.env") });

// ── Config ────────────────────────────────────────────────────────────────────
const RPC_URL             = process.env.RPC_URL!;
const PRIVATE_KEY         = process.env.PRIVATE_KEY!;
const LENDING_POOL_ADDRESS = "0xA7b4191aDE779bD96BCeF291cd4d809A7cd69b5B";
const POLL_INTERVAL_MS    = 30_000;   // check every 30s
const WARNING_THRESHOLD   = 1.3;      // warn when HF < 1.3

const POOL_ABI = [
  "event Borrowed(address indexed user, uint256 amount)",
  "event HealthWarning(address indexed user, uint256 healthFactor, uint256 timestamp)",
  "function getUserPosition(address user) external view returns (uint256 collateral, uint256 debt, uint256 healthFactor)",
  "function warnUser(address user) external",
  "function lastWarning(address user) external view returns (uint256)",
];

// ── State file for tracking known borrowers ───────────────────────────────────
const STATE_FILE = path.join(__dirname, "state.json");

function loadBorrowers(): Set<string> {
  if (existsSync(STATE_FILE)) {
    const data = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    return new Set<string>(data.borrowers ?? []);
  }
  return new Set<string>();
}

function saveBorrowers(set: Set<string>): void {
  writeFileSync(STATE_FILE, JSON.stringify({ borrowers: [...set] }, null, 2));
}

// ── AI Risk Assessment (rule-based with natural language output) ───────────────
function assessRisk(address: string, hf: number): string {
  if (hf < 1.05) {
    return `🔴 CRITICAL: ${address.slice(0, 8)}… HF=${hf.toFixed(4)} — Liquidation is IMMINENT. Position needs immediate action.`;
  } else if (hf < 1.15) {
    return `🟠 HIGH RISK: ${address.slice(0, 8)}… HF=${hf.toFixed(4)} — Very close to liquidation threshold (1.0). Repay debt or add collateral urgently.`;
  } else {
    return `🟡 WARNING: ${address.slice(0, 8)}… HF=${hf.toFixed(4)} — Position is at risk. Health factor is below the 1.3 safety threshold.`;
  }
}

// ── Main Agent Loop ───────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════");
  console.log("        NovaDot AI Health Monitor Agent");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Pool address : ${LENDING_POOL_ADDRESS}`);
  console.log(`  Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`  Warning at HF: < ${WARNING_THRESHOLD}`);
  console.log("═══════════════════════════════════════════════════\n");

  const provider  = new JsonRpcProvider(RPC_URL);
  const wallet    = new Wallet(PRIVATE_KEY, provider);
  const pool      = new Contract(LENDING_POOL_ADDRESS, POOL_ABI, wallet);
  const poolRead  = new Contract(LENDING_POOL_ADDRESS, POOL_ABI, provider);

  // ── Step 1: bootstrap borrower list from historical Borrowed events ─────────
  const borrowers = loadBorrowers();
  console.log(`[INIT] Loaded ${borrowers.size} known borrowers from state.`);

  try {
    const currentBlock = await provider.getBlockNumber();
    const fromBlock    = Math.max(0, currentBlock - 100_000);
    console.log(`[INIT] Scanning Borrowed events from block ${fromBlock}…`);
    const filter = poolRead.filters.Borrowed();
    const events = await poolRead.queryFilter(filter, fromBlock);
    for (const event of events) {
      if ("args" in event && event.args) {
        borrowers.add(event.args[0] as string);
      }
    }
    saveBorrowers(borrowers);
    console.log(`[INIT] ${borrowers.size} total borrowers tracked.\n`);
  } catch (e) {
    console.warn("[INIT] Could not load historical events:", (e as Error).message);
  }

  // ── Step 2: track new borrowers each poll (Polkadot RPC has no eth_newFilter) ──
  let lastScannedBlock = await provider.getBlockNumber();

  // ── Step 3: periodic health factor poll ────────────────────────────────────
  console.log("[AGENT] Starting monitoring loop…");


  async function checkPositions(): Promise<void> {
    const now = new Date().toISOString();
    if (borrowers.size === 0) {
      console.log(`[${now}] No active borrowers to monitor.`);
      return;
    }

    console.log(`[${now}] Checking ${borrowers.size} borrower(s)…`);

    // Discover any new borrowers since last poll
    try {
      const currentBlock = await provider.getBlockNumber();
      if (currentBlock > lastScannedBlock) {
        const newEvents = await poolRead.queryFilter(poolRead.filters.Borrowed(), lastScannedBlock + 1, currentBlock);
        for (const event of newEvents) {
          if ("args" in event && event.args) {
            const user = event.args[0] as string;
            if (!borrowers.has(user)) {
              borrowers.add(user);
              saveBorrowers(borrowers);
              console.log(`  [NEW] Borrower discovered: ${user}`);
            }
          }
        }
        lastScannedBlock = currentBlock;
      }
    } catch { /* queryFilter can fail on some nodes — skip silently */ }

    for (const user of borrowers) {
      try {
        const [collateral, debt, hfRaw] = await poolRead.getUserPosition(user);

        // Skip users with no debt
        if (debt === 0n) continue;

        const hf = parseFloat(formatUnits(hfRaw, 18));
        const col = parseFloat(formatUnits(collateral, 18)).toFixed(2);
        const dbt = parseFloat(formatUnits(debt, 6)).toFixed(2);

        console.log(`  ${user.slice(0, 10)}… | HF: ${hf.toFixed(4)} | WDOT: ${col} | Debt: $${dbt}`);

        if (hf < WARNING_THRESHOLD) {
          // Check if cooldown has passed (1 hour)
          const lastWarn = await poolRead.lastWarning(user);
          const elapsed  = Date.now() / 1000 - Number(lastWarn);

          if (elapsed >= 3600) {
            console.log(`\n  ⚡ Issuing on-chain warning for ${user}…`);
            const tx = await pool.warnUser(user);
            await tx.wait();
            console.log(`  ${assessRisk(user, hf)}`);
            console.log(`  ✓  HealthWarning emitted on-chain — tx: ${tx.hash}\n`);
          } else {
            const remaining = Math.ceil((3600 - elapsed) / 60);
            console.log(`  ⏳ Cooldown active for ${user.slice(0, 10)}… (${remaining}m remaining)`);
          }
        }
      } catch (e) {
        console.warn(`  [WARN] Could not check ${user.slice(0, 10)}…:`, (e as Error).message.slice(0, 80));
      }
    }
    console.log();
  }

  // Run immediately, then on interval
  await checkPositions();
  setInterval(checkPositions, POLL_INTERVAL_MS);
}

main().catch((e: unknown) => {
  console.error("[FATAL]", e);
  process.exit(1);
});
