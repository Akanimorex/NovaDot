import React, { useState, useEffect, useCallback, useRef } from "react";
import { BrowserProvider, Contract, parseUnits, formatUnits } from "ethers";

// ── Deployed contract addresses (Paseo Asset Hub testnet) ─────────────────────
const LENDING_POOL_ADDRESS = "0xA7b4191aDE779bD96BCeF291cd4d809A7cd69b5B";
const WDOT_ADDRESS         = "0x9bDd7B1019E1C622b713679F24aA460fe17d16e9";
const USDC_ADDRESS         = "0xb924Dc33Ceaacbde696ED5EC3A70a6b6576c013c";

const POOL_ABI = [
  "function depositCollateral(uint256 amount) external",
  "function borrowStablecoin(uint256 amount) external",
  "function repayLoan(uint256 amount) external",
  "function withdrawCollateral(uint256 amount) external",
  "function liquidate(address borrower) external",
  "function getHealthFactor(address user) external view returns (uint256)",
  "function getUserPosition(address user) external view returns (uint256 collateral, uint256 debt, uint256 healthFactor)",
  "function warnUser(address user) external",
  "function lastWarning(address user) external view returns (uint256)",
  "event HealthWarning(address indexed user, uint256 healthFactor, uint256 timestamp)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function faucet() external",
  "function lastMint(address user) external view returns (uint256)"
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getProvider() { return new BrowserProvider(window.ethereum as any); }

type Tab = "deposit" | "borrow" | "repay" | "withdraw" | "liquidate";

interface Position {
  collateral: string;
  debt: string;
  healthFactor: string;
  wdotBalance: string;
  usdcBalance: string;
}

// ── NovaDot Logo SVG ─────────────────────────────────────────────────────────
function NovaDotLogo({ size = 40 }: { size?: number }) {
  const id = "ndg";
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id={id} x1="0" y1="100" x2="100" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor="#F0287A" />
          <stop offset="100%" stopColor="#8B2A8B" />
        </linearGradient>
      </defs>
      {[
        [1,0],[2,0],
        [0,1],[1,1],[2,1],[3,1],
        [0,2],[1,2],[2,2],[3,2],[4,2],
        [0,3],[1,3],[2,3],[3,3],[4,3],
        [1,4],[2,4],[3,4],
      ].map(([cx, cy], i) => (
        <circle key={i} cx={10 + cx * 20} cy={10 + cy * 20} r={8} fill={`url(#${id})`} />
      ))}
      <path d="M52 22 L78 22 L78 48" stroke={`url(#${id})`} strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M40 60 L76 24"         stroke={`url(#${id})`} strokeWidth="11" strokeLinecap="round" fill="none" />
    </svg>
  );
}

// ── Health Factor Arc Gauge ───────────────────────────────────────────────────
function HFGauge({ value }: { value: string }) {
  const isInfinite = value === "∞";
  const num        = isInfinite ? 3 : Math.min(parseFloat(value), 3);
  const pct        = Math.max(0, Math.min(1, (num - 0) / 3));
  const color      = num >= 1.5 ? "#4ade80" : num >= 1.2 ? "#facc15" : "#f87171";
  const label      = num >= 1.5 ? "SAFE" : num >= 1.2 ? "WARNING" : "DANGER";

  const r = 36, cx = 48, cy = 48;
  const circ = Math.PI * r;  // half circle
  const dash  = circ * pct;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      <svg width={96} height={56} viewBox="0 0 96 56">
        {/* Track */}
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
          fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="8" strokeLinecap="round" />
        {/* Fill */}
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
          fill="none" stroke={color} strokeWidth="8" strokeLinecap="round"
          strokeDasharray={`${dash} ${circ}`}
          style={{ filter: `drop-shadow(0 0 6px ${color}80)`, transition: "stroke-dasharray 0.6s ease" }} />
      </svg>
      <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 22, fontWeight: 800, color, lineHeight: 1, marginTop: -10 }}>{value}</div>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: color + "aa", textTransform: "uppercase" }}>{isInfinite ? "NO DEBT" : label}</div>
    </div>
  );
}

// ── Toast System ───────────────────────────────────────────────────────────────
type ToastType = "success" | "error" | "warning" | "info";
interface Toast { id: number; type: ToastType; title: string; message?: string; }

export default function App(): React.ReactElement {
  const [account, setAccount]           = useState<string>("");
  const [position, setPosition]         = useState<Position | null>(null);
  const [activeTab, setActiveTab]       = useState<Tab>("deposit");
  const [amount, setAmount]             = useState<string>("");
  const [borrowerAddr, setBorrowerAddr] = useState<string>("");
  const [loading, setLoading]           = useState<boolean>(false);
  const [refreshing, setRefreshing]     = useState<boolean>(false);
  const [walletMenu, setWalletMenu]     = useState<boolean>(false);
  const [toasts, setToasts]             = useState<Toast[]>([]);
  const toastId                         = useRef(0);

  function addToast(type: ToastType, title: string, message?: string) {
    const id = ++toastId.current;
    setToasts(prev => [...prev, { id, type, title, message }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 6000);
  }
  function removeToast(id: number) { setToasts(prev => prev.filter(t => t.id !== id)); }

  async function connectWallet() {
    if (!window.ethereum) { alert("MetaMask not detected."); return; }
    try {
      const provider = getProvider();
      await provider.send("eth_requestAccounts", []);
      const signer = await provider.getSigner();
      setAccount(await signer.getAddress());
    } catch (e: unknown) { addToast("error", "Connection failed", e instanceof Error ? e.message : String(e)); }
  }

  async function disconnectWallet() {
    try {
      await (window.ethereum as { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> })
        .request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
    } catch { /* older MetaMask versions may not support this */ }
    setAccount(""); setPosition(null); setWalletMenu(false);
  }

  const fetchPosition = useCallback(async () => {
    if (!account || !window.ethereum) return;
    setRefreshing(true);
    try {
      const provider = getProvider();
      const pool = new Contract(LENDING_POOL_ADDRESS, POOL_ABI, provider);
      const wdot = new Contract(WDOT_ADDRESS, ERC20_ABI, provider);
      const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, provider);
      const [collateral, debt, hf] = await pool.getUserPosition(account);
      const wdotBal = await wdot.balanceOf(account);
      const usdcBal = await usdc.balanceOf(account);
      setPosition({
        collateral:   formatUnits(collateral, 18),
        debt:         formatUnits(debt, 6),
        healthFactor: debt === 0n ? "∞" : parseFloat(formatUnits(hf, 18)).toFixed(4),
        wdotBalance:  parseFloat(formatUnits(wdotBal, 18)).toFixed(4),
        usdcBalance:  parseFloat(formatUnits(usdcBal, 6)).toFixed(2),
      });
    } catch (e: unknown) { addToast("error", "Failed to load position", e instanceof Error ? e.message : String(e)); }
    finally { setRefreshing(false); }
  }, [account]);

  useEffect(() => { if (account) fetchPosition(); }, [account, fetchPosition]);

  // ── Embedded AI health monitor — runs in the browser every 30s ─────────────
  useEffect(() => {
    if (!account || !window.ethereum) return;
    const WARNING_THRESHOLD = 1.3;
    const COOLDOWN_S        = 3600;
    let warnedThisSession   = false;

    async function checkAndWarn() {
      try {
        const provider = getProvider();
        const pool     = new Contract(LENDING_POOL_ADDRESS, POOL_ABI, provider);
        const [, debt, hfRaw] = await pool.getUserPosition(account);
        if (debt === 0n) { warnedThisSession = false; return; }
        const hf = parseFloat(formatUnits(hfRaw, 18));
        if (hf >= WARNING_THRESHOLD) { warnedThisSession = false; return; }
        if (!warnedThisSession) {
          warnedThisSession = true;
          addToast("warning", `⚠️ Position at Risk — HF ${hf.toFixed(4)}`,
            "Your health factor is below 1.3. Add collateral or repay debt to avoid liquidation.");
        }
        const lastWarn = await pool.lastWarning(account);
        const elapsedS = Math.floor(Date.now() / 1000) - Number(lastWarn);
        if (elapsedS >= COOLDOWN_S) {
          try {
            const signer    = await getProvider().getSigner();
            const poolWrite = new Contract(LENDING_POOL_ADDRESS, POOL_ABI, signer);
            const tx        = await poolWrite.warnUser(account);
            await tx.wait();
          } catch { /* silent */ }
        }
      } catch { /* network error — silent */ }
    }

    checkAndWarn();
    const interval = setInterval(checkAndWarn, 30_000);
    return () => clearInterval(interval);
  }, [account]);

  async function approveAndCall(
    tokenAddress: string, decimals: number, rawAmount: string,
    action: (signer: Awaited<ReturnType<BrowserProvider["getSigner"]>>) => Promise<{ hash: string }>
  ) {
    setLoading(true);
    try {
      const signer = await getProvider().getSigner();
      const token  = new Contract(tokenAddress, ERC20_ABI, signer);
      const parsed = parseUnits(rawAmount, decimals);
      addToast("info", "Approving token…", "Please confirm in MetaMask");
      const approveTx = await token.approve(LENDING_POOL_ADDRESS, parsed);
      await approveTx.wait();
      const tx = await action(signer);
      addToast("info", "Transaction submitted", "Waiting for confirmation…");
      const receipt = await getProvider().waitForTransaction(tx.hash);
      if (!receipt || receipt.status === 0) throw new Error("Transaction reverted");
      addToast("success", "Transaction confirmed! ✨", tx.hash);
      await fetchPosition(); setAmount("");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      addToast("error", "Transaction failed", msg.length > 120 ? msg.slice(0, 120) + "…" : msg);
    } finally { setLoading(false); }
  }

  async function callPool(action: (signer: Awaited<ReturnType<BrowserProvider["getSigner"]>>) => Promise<{ hash: string }>) {
    setLoading(true);
    try {
      const signer = await getProvider().getSigner();
      const tx = await action(signer);
      addToast("info", "Transaction submitted", "Waiting for confirmation…");
      const receipt = await getProvider().waitForTransaction(tx.hash);
      if (!receipt || receipt.status === 0) throw new Error("Transaction reverted");
      addToast("success", "Transaction confirmed! ✨", tx.hash);
      await fetchPosition(); setAmount(""); setBorrowerAddr("");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      addToast("error", "Transaction failed", msg.length > 120 ? msg.slice(0, 120) + "…" : msg);
    } finally { setLoading(false); }
  }

  const handleDeposit   = () => approveAndCall(WDOT_ADDRESS, 18, amount, async (s) => new Contract(LENDING_POOL_ADDRESS, POOL_ABI, s).depositCollateral(parseUnits(amount, 18)));
  const handleBorrow    = () => callPool(async (s) => new Contract(LENDING_POOL_ADDRESS, POOL_ABI, s).borrowStablecoin(parseUnits(amount, 6)));
  const handleRepay     = () => approveAndCall(USDC_ADDRESS, 6, amount, async (s) => new Contract(LENDING_POOL_ADDRESS, POOL_ABI, s).repayLoan(parseUnits(amount, 6)));
  const handleWithdraw  = () => callPool(async (s) => new Contract(LENDING_POOL_ADDRESS, POOL_ABI, s).withdrawCollateral(parseUnits(amount, 18)));
  const handleLiquidate = () => callPool(async (s) => new Contract(LENDING_POOL_ADDRESS, POOL_ABI, s).liquidate(borrowerAddr));

  async function handleFaucet(tokenAddress: string, tokenName: string) {
    setLoading(true);
    try {
      const signer = await getProvider().getSigner();
      const token = new Contract(tokenAddress, ERC20_ABI, signer);
      const last = await token.lastMint(account);
      const now = Math.floor(Date.now() / 1000);
      if (now < Number(last) + 86400) throw new Error("Faucet is on a 24-hour cooldown. Try again later.");
      addToast("info", `Minting ${tokenName}…`, "Please confirm in MetaMask");
      const tx = await token.faucet();
      await tx.wait();
      addToast("success", `${tokenName} received! 🎉`, `${tokenName === "WDOT" ? "100 WDOT" : "1,000 USDC"} added to your wallet`);
      await fetchPosition();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      addToast("error", "Faucet failed", msg.length > 120 ? msg.slice(0, 120) + "…" : msg);
    } finally { setLoading(false); }
  }

  function hfColor(hf: string) {
    if (hf === "∞") return "#4ade80";
    const v = parseFloat(hf);
    return v >= 1.5 ? "#4ade80" : v >= 1.2 ? "#facc15" : "#f87171";
  }

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "deposit",   label: "Deposit",   icon: "⬇" },
    { id: "borrow",    label: "Borrow",    icon: "💸" },
    { id: "repay",     label: "Repay",     icon: "↩" },
    { id: "withdraw",  label: "Withdraw",  icon: "⬆" },
    { id: "liquidate", label: "Liquidate", icon: "⚡" },
  ];

  const tabConfig: Record<Tab, { title: string; desc: string; info: React.ReactNode; unit: string; isLiquidate?: boolean }> = {
    deposit:   { title: "Deposit WDOT Collateral",  unit: "WDOT", desc: "Lock WDOT to increase your borrowing power. Requires 150% collateral ratio to borrow.", info: <>Wallet balance: <b>{position?.wdotBalance ?? "–"} WDOT</b></> },
    borrow:    { title: "Borrow MockUSDC",           unit: "USDC", desc: "Borrow stablecoin against your locked WDOT. Requires ≥ 150% collateral ratio.", info: <>Current debt: <b>{position?.debt ?? "–"} USDC</b></> },
    repay:     { title: "Repay Loan",                unit: "USDC", desc: "Repay principal + accrued interest (10% APR). Overpayment is automatically capped.", info: <>Total owed (approx): <b>{position?.debt ?? "–"} USDC</b></> },
    withdraw:  { title: "Withdraw Collateral",       unit: "WDOT", desc: "Reclaim your WDOT. Position must remain above 150% collateral ratio after withdrawal.", info: <>Deposited: <b>{position?.collateral ?? "–"} WDOT</b></> },
    liquidate: { title: "Liquidate Position",        unit: "",     desc: "Repay an undercollateralised borrower's debt and receive their WDOT + 5% bonus.", info: <>Target Health Factor must be <b>&lt; 1.0</b></>, isLiquidate: true },
  };

  const cfg = tabConfig[activeTab];

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;700&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        body {
          font-family: 'Inter', sans-serif;
          background: #060410;
          min-height: 100vh;
          color: #ede8f5;
          overflow-x: hidden;
        }

        /* ── Animated background ── */
        .bg-mesh {
          position: fixed; inset: 0; z-index: 0; overflow: hidden; pointer-events: none;
        }
        .bg-mesh::before {
          content: '';
          position: absolute; inset: -50%;
          background:
            radial-gradient(ellipse 60% 40% at 20% 30%, rgba(240,40,122,0.18) 0%, transparent 70%),
            radial-gradient(ellipse 50% 50% at 80% 80%, rgba(139,42,139,0.15) 0%, transparent 70%),
            radial-gradient(ellipse 40% 60% at 60% 10%, rgba(99,30,160,0.12) 0%, transparent 70%);
          animation: meshDrift 18s ease-in-out infinite alternate;
        }
        @keyframes meshDrift {
          0%   { transform: translate(0, 0) scale(1); }
          50%  { transform: translate(-2%, 3%) scale(1.04); }
          100% { transform: translate(2%, -2%) scale(0.97); }
        }
        .bg-grid {
          position: fixed; inset: 0; z-index: 0; pointer-events: none;
          background-image:
            linear-gradient(rgba(240,40,122,0.04) 1px, transparent 1px),
            linear-gradient(90deg, rgba(240,40,122,0.04) 1px, transparent 1px);
          background-size: 48px 48px;
          mask-image: radial-gradient(ellipse 80% 80% at 50% 50%, black 40%, transparent 100%);
        }

        /* ── Layout ── */
        .app-wrap {
          position: relative; z-index: 1;
          max-width: 960px; margin: 0 auto;
          padding: 28px 20px 100px;
        }

        /* ── Header ── */
        .hdr {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 48px;
          padding: 12px 20px;
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(240,40,122,0.12);
          border-radius: 20px;
          backdrop-filter: blur(20px);
          position: relative; z-index: 50;
        }
        .brand { display: flex; align-items: center; gap: 12px; }
        .brand-name {
          font-size: 20px; font-weight: 900; letter-spacing: -0.8px;
          background: linear-gradient(120deg, #F0287A 0%, #c4259f 50%, #8B2A8B 100%);
          -webkit-background-clip: text; -webkit-text-fill-color: transparent;
        }
        .brand-tag {
          font-size: 10px; color: rgba(240,40,122,0.6); font-weight: 500;
          letter-spacing: 0.5px; margin-top: 1px;
        }
        .testnet-pill {
          padding: 3px 10px; border-radius: 100px;
          background: rgba(240,40,122,0.1); border: 1px solid rgba(240,40,122,0.2);
          font-size: 10px; color: #F0287A; font-weight: 700; letter-spacing: 0.5px;
        }

        .connect-btn {
          padding: 10px 24px;
          background: linear-gradient(135deg, #F0287A, #8B2A8B);
          border: none; border-radius: 12px; color: #fff;
          font-size: 14px; font-weight: 700; letter-spacing: 0.3px;
          cursor: pointer; transition: all 0.2s;
          box-shadow: 0 4px 20px rgba(240,40,122,0.3);
        }
        .connect-btn:hover { transform: translateY(-1px); box-shadow: 0 8px 28px rgba(240,40,122,0.45); }

        .acct-badge {
          display: flex; align-items: center; gap: 8px;
          padding: 8px 16px; border-radius: 12px;
          background: rgba(240,40,122,0.08); border: 1px solid rgba(240,40,122,0.2);
          font-size: 13px; font-weight: 600; color: #e0a0d0;
          cursor: pointer; position: relative; transition: background 0.2s;
          font-family: 'JetBrains Mono', monospace;
        }
        .acct-badge:hover { background: rgba(240,40,122,0.14); }
        .pulse { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; animation: pulseGlow 2s ease infinite; flex-shrink: 0; }
        @keyframes pulseGlow { 0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(74,222,128,0.4)} 50%{opacity:.8;box-shadow:0 0 0 4px rgba(74,222,128,0)} }

        .wallet-menu {
          position: absolute; top: calc(100% + 10px); right: 0;
          background: rgba(12,5,22,0.95); border: 1px solid rgba(240,40,122,0.25);
          border-radius: 16px; padding: 8px; min-width: 240px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.6); z-index: 200;
          backdrop-filter: blur(20px);
          animation: menuPop 0.15s cubic-bezier(0.34,1.56,0.64,1);
        }
        @keyframes menuPop { from { opacity:0; transform:translateY(-6px) scale(0.97); } to { opacity:1; transform:translateY(0) scale(1); } }
        .wallet-addr {
          font-size: 10px; color: #7a5a88; padding: 10px 12px 6px;
          word-break: break-all; font-family: 'JetBrains Mono', monospace; line-height: 1.6;
        }
        .wallet-menu-sep { border: none; border-top: 1px solid rgba(240,40,122,0.1); margin: 6px 0; }
        .wallet-menu-btn {
          width: 100%; padding: 9px 12px; border: none; border-radius: 10px;
          background: none; color: #c97ab0; font-size: 13px; font-weight: 500;
          cursor: pointer; text-align: left; transition: all 0.15s;
          display: flex; align-items: center; gap: 8px; font-family: 'Inter', sans-serif;
        }
        .wallet-menu-btn:hover { background: rgba(240,40,122,0.1); color: #f0e8f5; }
        .wallet-menu-btn.danger:hover { background: rgba(248,113,113,0.1); color: #f87171; }

        /* ── Bento Stats Grid ── */
        .bento {
          display: grid;
          grid-template-columns: 1fr 1fr 1.3fr 1fr;
          gap: 14px;
          margin-bottom: 20px;
        }
        @media (max-width: 700px) { .bento { grid-template-columns: 1fr 1fr; } }

        .bento-card {
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(240,40,122,0.1);
          border-radius: 20px; padding: 20px;
          backdrop-filter: blur(16px);
          transition: border-color 0.25s, transform 0.2s;
          position: relative; overflow: hidden;
        }
        .bento-card::before {
          content: '';
          position: absolute; top: 0; left: 0; right: 0; height: 1px;
          background: linear-gradient(90deg, transparent, rgba(240,40,122,0.3), transparent);
        }
        .bento-card:hover { border-color: rgba(240,40,122,0.25); transform: translateY(-1px); }
        .bento-card.hf-card { grid-column: span 1; background: rgba(240,40,122,0.04); }

        .bento-lbl {
          font-size: 10px; font-weight: 700; text-transform: uppercase;
          letter-spacing: 1px; color: rgba(240,40,122,0.6); margin-bottom: 10px;
          display: flex; align-items: center; gap: 6px;
        }
        .bento-lbl-dot { width: 4px; height: 4px; border-radius: 50%; background: #F0287A; }
        .bento-val {
          font-size: 26px; font-weight: 800; letter-spacing: -1px;
          font-family: 'JetBrains Mono', monospace; color: #f0e8f5;
          line-height: 1.1;
        }
        .bento-sub { font-size: 11px; color: #5a4070; margin-top: 6px; font-weight: 500; }

        .wallet-bento {
          display: flex; flex-direction: column; justify-content: space-between;
        }
        .wallet-bal-row { display: flex; flex-direction: column; gap: 6px; }
        .wallet-bal {
          display: flex; align-items: center; justify-content: space-between;
          padding: 8px 10px;
          background: rgba(240,40,122,0.06); border-radius: 10px;
          font-size: 12px;
        }
        .wallet-bal-label { color: #7a5a88; font-weight: 600; }
        .wallet-bal-val { color: #f0e8f5; font-family: 'JetBrains Mono', monospace; font-weight: 700; font-size: 12px; }

        .refresh-btn {
          background: none; border: 1px solid rgba(240,40,122,0.15);
          color: #7a5a88; cursor: pointer; font-size: 11px; padding: 5px 12px;
          border-radius: 8px; transition: all 0.2s; margin-top: 10px;
          font-family: 'Inter', sans-serif; font-weight: 500;
        }
        .refresh-btn:hover { color: #F0287A; border-color: rgba(240,40,122,0.4); background: rgba(240,40,122,0.07); }

        /* ── Faucet Banner ── */
        .faucet-bar {
          display: flex; align-items: center; justify-content: space-between;
          padding: 12px 20px; margin-bottom: 14px;
          background: rgba(255,255,255,0.02);
          border: 1px solid rgba(240,40,122,0.1);
          border-radius: 16px; backdrop-filter: blur(12px);
        }
        .faucet-label { font-size: 12px; color: #7a5a88; font-weight: 600; letter-spacing: 0.3px; }
        .faucet-btns  { display: flex; gap: 8px; }
        .faucet-btn {
          padding: 7px 16px; border-radius: 10px;
          font-size: 12px; font-weight: 700; cursor: pointer;
          transition: all 0.2s; font-family: 'Inter', sans-serif;
          letter-spacing: 0.3px;
        }
        .faucet-btn.wdot {
          background: rgba(240,40,122,0.12); border: 1px solid rgba(240,40,122,0.3);
          color: #f0288a;
        }
        .faucet-btn.wdot:hover { background: rgba(240,40,122,0.22); box-shadow: 0 4px 16px rgba(240,40,122,0.2); }
        .faucet-btn.usdc {
          background: rgba(139,42,139,0.15); border: 1px solid rgba(139,42,139,0.35);
          color: #d07ad0;
        }
        .faucet-btn.usdc:hover { background: rgba(139,42,139,0.25); box-shadow: 0 4px 16px rgba(139,42,139,0.2); }
        .faucet-btn:disabled { opacity: 0.4; cursor: not-allowed; }

        /* ── Action Card ── */
        .action-card {
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(240,40,122,0.1);
          border-radius: 24px; overflow: hidden;
          backdrop-filter: blur(24px);
          box-shadow: 0 8px 48px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.05);
        }

        /* ── Tabs ── */
        .tabs-wrap {
          display: flex; gap: 6px; padding: 10px;
          background: rgba(0,0,0,0.25);
          border-bottom: 1px solid rgba(240,40,122,0.08);
        }
        .tab {
          flex: 1; padding: 9px 4px; border: none; border-radius: 12px;
          background: none; color: #5a4070; font-size: 12px; font-weight: 600;
          cursor: pointer; transition: all 0.2s;
          display: flex; align-items: center; justify-content: center; gap: 5px;
          font-family: 'Inter', sans-serif;
        }
        .tab:hover { color: #c97ab0; background: rgba(240,40,122,0.07); }
        .tab.active {
          background: linear-gradient(135deg, rgba(240,40,122,0.2), rgba(139,42,139,0.2));
          color: #f0e8f5; border: 1px solid rgba(240,40,122,0.25);
          box-shadow: 0 2px 12px rgba(240,40,122,0.15);
        }

        /* ── Panel ── */
        .panel { padding: 28px 28px 24px; }

        .panel-header { margin-bottom: 20px; }
        .panel-title {
          font-size: 18px; font-weight: 800; letter-spacing: -0.4px;
          color: #f0e8f5; margin-bottom: 4px;
        }
        .panel-desc { font-size: 12px; color: #6a4a7a; line-height: 1.7; }

        .info-row {
          display: flex; align-items: center; gap: 10px;
          padding: 12px 16px; margin-bottom: 20px;
          background: rgba(240,40,122,0.06); border: 1px solid rgba(240,40,122,0.14);
          border-radius: 12px; font-size: 12px; color: #b07aa8; line-height: 1.6;
        }
        .info-row-icon { font-size: 16px; flex-shrink: 0; }
        .info-row b { color: #f0e8f5; font-weight: 700; }

        .field-lbl {
          display: block; font-size: 10px; font-weight: 800;
          text-transform: uppercase; letter-spacing: 1px;
          color: rgba(240,40,122,0.7); margin-bottom: 8px;
        }

        .inp-wrap { position: relative; margin-bottom: 20px; }
        .inp-wrap input, .addr-inp {
          width: 100%;
          padding: 15px 70px 15px 18px;
          background: rgba(240,40,122,0.05);
          border: 1px solid rgba(240,40,122,0.15);
          border-radius: 14px; color: #f0e8f5;
          font-size: 18px; font-weight: 600;
          font-family: 'JetBrains Mono', monospace;
          outline: none; transition: border-color 0.2s, box-shadow 0.2s;
        }
        .addr-inp {
          padding: 15px 18px; font-size: 13px;
          font-family: 'JetBrains Mono', monospace; margin-bottom: 20px;
        }
        .inp-wrap input:focus, .addr-inp:focus {
          border-color: rgba(240,40,122,0.5);
          box-shadow: 0 0 0 3px rgba(240,40,122,0.12),
                      0 0 20px rgba(240,40,122,0.08);
        }
        .inp-wrap input::placeholder, .addr-inp::placeholder { color: #3d2250; }
        .inp-unit {
          position: absolute; right: 16px; top: 50%; transform: translateY(-50%);
          font-size: 12px; font-weight: 800; color: #F0287A;
          font-family: 'Inter', sans-serif; letter-spacing: 0.5px;
          background: rgba(240,40,122,0.12); padding: 4px 10px;
          border-radius: 8px;
        }

        .action-btn {
          width: 100%; padding: 16px;
          background: linear-gradient(135deg, #F0287A 0%, #a022a0 100%);
          border: none; border-radius: 14px; color: #fff;
          font-size: 15px; font-weight: 800; letter-spacing: 0.3px;
          cursor: pointer; transition: all 0.2s;
          font-family: 'Inter', sans-serif;
          box-shadow: 0 4px 24px rgba(240,40,122,0.3);
          position: relative; overflow: hidden;
        }
        .action-btn::before {
          content: '';
          position: absolute; inset: 0;
          background: linear-gradient(135deg, rgba(255,255,255,0.15), transparent);
          opacity: 0; transition: opacity 0.2s;
        }
        .action-btn:hover:not(:disabled)::before { opacity: 1; }
        .action-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 8px 32px rgba(240,40,122,0.45); }
        .action-btn:active:not(:disabled) { transform: translateY(0); }
        .action-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .action-btn.danger {
          background: linear-gradient(135deg, #dc2626 0%, #8B2A8B 100%);
          box-shadow: 0 4px 24px rgba(220,38,38,0.3);
        }
        .action-btn.danger:hover:not(:disabled) { box-shadow: 0 8px 32px rgba(220,38,38,0.45); }

        /* ── Spinner ── */
        @keyframes spin { to { transform: rotate(360deg); } }
        .spinner {
          display: inline-block; width: 14px; height: 14px;
          border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff;
          border-radius: 50%; animation: spin 0.7s linear infinite;
          vertical-align: middle; margin-right: 8px;
        }

        /* ── Toast ── */
        .toast-container {
          position: fixed; bottom: 28px; right: 24px; z-index: 9999;
          display: flex; flex-direction: column-reverse; gap: 10px; max-width: 360px;
        }
        @keyframes slideUp { from { opacity:0; transform:translateY(20px); } to { opacity:1; transform:translateY(0); } }
        .toast {
          display: flex; align-items: flex-start; gap: 12px;
          padding: 14px 16px; border-radius: 16px;
          backdrop-filter: blur(20px); animation: slideUp 0.25s cubic-bezier(0.34,1.2,0.64,1);
          box-shadow: 0 12px 40px rgba(0,0,0,0.5);
        }
        .toast-success { background: rgba(15,30,20,0.92); border: 1px solid rgba(74,222,128,0.35); }
        .toast-error   { background: rgba(30,10,10,0.92); border: 1px solid rgba(248,113,113,0.35); }
        .toast-warning { background: rgba(30,20,5,0.92);  border: 1px solid rgba(251,146,60,0.4); }
        .toast-info    { background: rgba(10,20,40,0.92); border: 1px solid rgba(96,165,250,0.35); }
        .toast-icon  { font-size: 18px; flex-shrink: 0; margin-top: 1px; }
        .toast-body  { flex: 1; min-width: 0; }
        .toast-title { font-size: 13px; font-weight: 700; color: #f0e8f5; margin-bottom: 2px; }
        .toast-msg   { font-size: 11px; color: #907898; line-height: 1.5; word-break: break-all; }
        .toast-msg a { color: #60a5fa; text-decoration: underline; }
        .toast-close {
          background: none; border: none; color: #4a3060; cursor: pointer;
          font-size: 16px; padding: 0; flex-shrink: 0; line-height: 1;
          transition: color 0.15s;
        }
        .toast-close:hover { color: #f0e8f5; }

        /* ── Landing page ── */
        .landing {
          text-align: center;
          padding: 60px 24px 80px;
        }
        .landing-logo { margin-bottom: 32px; position: relative; display: inline-block; }
        .landing-logo-glow {
          position: absolute; top: 50%; left: 50%;
          transform: translate(-50%,-50%);
          width: 120px; height: 120px; border-radius: 50%;
          background: radial-gradient(circle, rgba(240,40,122,0.3) 0%, transparent 70%);
          filter: blur(20px);
        }
        .landing-title {
          font-size: 52px; font-weight: 900; letter-spacing: -2px;
          line-height: 1.05; margin-bottom: 8px;
          background: linear-gradient(135deg, #ff6aa8 0%, #F0287A 40%, #c034b8 75%, #8B2A8B 100%);
          -webkit-background-clip: text; -webkit-text-fill-color: transparent;
        }
        .landing-sub {
          font-size: 14px; color: #6a4a7a; line-height: 1.8;
          margin-bottom: 48px; max-width: 420px; margin-left: auto; margin-right: auto;
        }
        .landing-stats {
          display: flex; gap: 12px; flex-wrap: wrap; justify-content: center;
          margin-bottom: 48px;
        }
        .landing-stat {
          padding: 14px 22px; border-radius: 16px;
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(240,40,122,0.15);
          backdrop-filter: blur(12px);
          text-align: left; min-width: 110px;
        }
        .landing-stat-val { font-size: 22px; font-weight: 800; color: #F0287A; font-family: 'JetBrains Mono', monospace; }
        .landing-stat-lbl { font-size: 10px; color: #6a4a7a; font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px; margin-top: 2px; }

        .landing-cta {
          padding: 16px 52px;
          background: linear-gradient(135deg, #F0287A, #a022a0);
          border: none; border-radius: 16px; color: #fff;
          font-size: 16px; font-weight: 800; letter-spacing: 0.3px;
          cursor: pointer; transition: all 0.2s;
          font-family: 'Inter', sans-serif;
          box-shadow: 0 8px 32px rgba(240,40,122,0.4);
        }
        .landing-cta:hover { transform: translateY(-2px); box-shadow: 0 12px 40px rgba(240,40,122,0.55); }

        /* ── Scrollbar ── */
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(240,40,122,0.3); border-radius: 3px; }
      `}</style>

      <div className="bg-mesh" />
      <div className="bg-grid" />

      <div className="app-wrap">
        {/* ── Header ── */}
        <header className="hdr">
          <div className="brand">
            <NovaDotLogo size={38} />
            <div>
              <div className="brand-name">NovaDot</div>
              <div className="brand-tag">DeFi Lending · Polkadot Hub EVM</div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="testnet-pill">TESTNET</span>
            {!account
              ? <button className="connect-btn" onClick={connectWallet}>Connect Wallet</button>
              : (
                <div className="acct-badge" onClick={() => setWalletMenu(m => !m)}>
                  <span className="pulse" />
                  {account.slice(0,6)}…{account.slice(-4)}
                  <span style={{ fontSize: 10, opacity: 0.5 }}>▾</span>
                  {walletMenu && (
                    <div className="wallet-menu" onClick={e => e.stopPropagation()}>
                      <div className="wallet-addr">{account}</div>
                      <hr className="wallet-menu-sep" />
                      <button className="wallet-menu-btn" onClick={() => { navigator.clipboard.writeText(account); setWalletMenu(false); }}>
                        📋 Copy Address
                      </button>
                      <button className="wallet-menu-btn" onClick={() => window.open(`https://blockscout-passet-hub.parity-testnet.parity.io/address/${account}`, "_blank")}>
                        🔍 View on Explorer
                      </button>
                      <hr className="wallet-menu-sep" />
                      <button className="wallet-menu-btn danger" onClick={disconnectWallet}>
                        🔌 Disconnect
                      </button>
                    </div>
                  )}
                </div>
              )
            }
          </div>
        </header>

        {!account ? (
          /* ── Landing Page ── */
          <div className="landing">
            <div className="landing-logo">
              <div className="landing-logo-glow" />
              <NovaDotLogo size={88} />
            </div>
            <div className="landing-title">Lend Smarter.<br/>Borrow Boldly.</div>
            <p className="landing-sub">
              Deposit WDOT as collateral, borrow stablecoins instantly.<br/>
              AI-powered health monitoring keeps your position safe.
            </p>
            <div className="landing-stats">
              <div className="landing-stat">
                <div className="landing-stat-val">150%</div>
                <div className="landing-stat-lbl">Min Collateral</div>
              </div>
              <div className="landing-stat">
                <div className="landing-stat-val">10%</div>
                <div className="landing-stat-lbl">APR</div>
              </div>
              <div className="landing-stat">
                <div className="landing-stat-val">120%</div>
                <div className="landing-stat-lbl">Liq. Threshold</div>
              </div>
              <div className="landing-stat">
                <div className="landing-stat-val">5%</div>
                <div className="landing-stat-lbl">Liq. Bonus</div>
              </div>
            </div>
            <button className="landing-cta" onClick={connectWallet}>
              Launch App →
            </button>
          </div>
        ) : (
          <>
            {/* ── Bento Stats Grid ── */}
            {position && (
              <div className="bento">
                <div className="bento-card">
                  <div className="bento-lbl"><span className="bento-lbl-dot"/>Collateral</div>
                  <div className="bento-val">{parseFloat(position.collateral).toFixed(2)}</div>
                  <div className="bento-sub">WDOT deposited</div>
                </div>

                <div className="bento-card">
                  <div className="bento-lbl"><span className="bento-lbl-dot"/>Debt</div>
                  <div className="bento-val" style={{ color: parseFloat(position.debt) > 0 ? "#facc15" : "#4ade80" }}>
                    {parseFloat(position.debt).toFixed(2)}
                  </div>
                  <div className="bento-sub">USDC borrowed</div>
                </div>

                <div className="bento-card hf-card" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                  <div className="bento-lbl" style={{ marginBottom: 6 }}><span className="bento-lbl-dot"/>Health Factor</div>
                  <HFGauge value={position.healthFactor} />
                </div>

                <div className="bento-card wallet-bento">
                  <div className="bento-lbl"><span className="bento-lbl-dot"/>Wallet</div>
                  <div className="wallet-bal-row">
                    <div className="wallet-bal">
                      <span className="wallet-bal-label">WDOT</span>
                      <span className="wallet-bal-val">{position.wdotBalance}</span>
                    </div>
                    <div className="wallet-bal">
                      <span className="wallet-bal-label">USDC</span>
                      <span className="wallet-bal-val">{position.usdcBalance}</span>
                    </div>
                  </div>
                  <button className="refresh-btn" onClick={fetchPosition} disabled={refreshing}>
                    {refreshing ? "↻ Loading…" : "↻ Refresh"}
                  </button>
                </div>
              </div>
            )}

            {/* ── Faucet Bar ── */}
            <div className="faucet-bar">
              <span className="faucet-label">🚰 Testnet Faucet</span>
              <div className="faucet-btns">
                <button className="faucet-btn wdot" onClick={() => handleFaucet(WDOT_ADDRESS, "WDOT")} disabled={loading}>
                  + 100 WDOT
                </button>
                <button className="faucet-btn usdc" onClick={() => handleFaucet(USDC_ADDRESS, "USDC")} disabled={loading}>
                  + 1,000 USDC
                </button>
              </div>
            </div>

            {/* ── Action Card ── */}
            <div className="action-card">
              <div className="tabs-wrap">
                {tabs.map(t => (
                  <button key={t.id} className={`tab${activeTab === t.id ? " active" : ""}`}
                    onClick={() => { setActiveTab(t.id); setAmount(""); }}>
                    <span>{t.icon}</span> {t.label}
                  </button>
                ))}
              </div>

              <div className="panel">
                <div className="panel-header">
                  <div className="panel-title">{cfg.title}</div>
                  <div className="panel-desc">{cfg.desc}</div>
                </div>

                <div className="info-row">
                  <span className="info-row-icon">ℹ️</span>
                  <span>{cfg.info}</span>
                </div>

                <label className="field-lbl">
                  {cfg.isLiquidate ? "Borrower Address" : `Amount (${cfg.unit})`}
                </label>

                {cfg.isLiquidate ? (
                  <input className="addr-inp" placeholder="0x… borrower address"
                    value={borrowerAddr} onChange={e => setBorrowerAddr(e.target.value)} />
                ) : (
                  <div className="inp-wrap">
                    <input type="number" placeholder="0.00" min="0"
                      value={amount} onChange={e => setAmount(e.target.value)} />
                    {cfg.unit && <span className="inp-unit">{cfg.unit}</span>}
                  </div>
                )}

                <button
                  className={`action-btn${cfg.isLiquidate ? " danger" : ""}`}
                  disabled={loading || (cfg.isLiquidate ? !borrowerAddr : !amount || parseFloat(amount) <= 0)}
                  onClick={() => {
                    if (activeTab === "deposit")        handleDeposit();
                    else if (activeTab === "borrow")    handleBorrow();
                    else if (activeTab === "repay")     handleRepay();
                    else if (activeTab === "withdraw")  handleWithdraw();
                    else                                handleLiquidate();
                  }}
                >
                  {loading ? <><span className="spinner" />Processing…</> : cfg.title}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Toast Notifications ── */}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.type}`}>
            <span className="toast-icon">
              {t.type === "success" ? "✅" : t.type === "error" ? "🛑" : t.type === "warning" ? "⚠️" : "ℹ️"}
            </span>
            <div className="toast-body">
              <div className="toast-title">{t.title}</div>
              {t.message && (
                <div className="toast-msg">
                  {t.type === "success" && t.message.startsWith("0x")
                    ? <a href={`https://blockscout-passet-hub.parity-testnet.parity.io/tx/${t.message}`} target="_blank" rel="noreferrer">View on Blockscout 🔗</a>
                    : t.message}
                </div>
              )}
            </div>
            <button className="toast-close" onClick={() => removeToast(t.id)}>✕</button>
          </div>
        ))}
      </div>
    </>
  );
}

declare global {
  interface Window { ethereum?: unknown; }
}
