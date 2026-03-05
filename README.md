# DotLend — Stablecoin Micro-Lending Protocol on Polkadot Hub EVM

A production-ready DeFi micro-lending protocol written in Solidity. Users deposit WDOT as collateral and borrow a
stablecoin (MockUSDC on testnet, real USDC on mainnet) against it.

---

## Project Overview

| Parameter               | Value                          |
|-------------------------|--------------------------------|
| Collateral token        | WDOT (Wrapped DOT, ERC-20)     |
| Borrow token            | MockUSDC (6 decimals)          |
| Min collateral ratio    | **150%** (to open a position)  |
| Liquidation threshold   | **120%** (below this, anyone can liquidate) |
| Interest rate           | **10% APR** (simple, accrued lazily) |
| Liquidation bonus       | **5%** (bonus WDOT to the liquidator) |
| Health Factor = 1.0     | `1e18` (standard Aave convention) |

---

## Architecture

```
contracts/
├── interfaces/
│   ├── ILendingPool.sol    — External interface for the core pool
│   └── IPriceOracle.sol    — Oracle interface (Chainlink-compatible)
├── LendingPool.sol         — Core protocol logic
├── MockUSDC.sol            — Mintable 6-decimal stablecoin (testnet)
├── MockWDOT.sol            — Mintable 18-decimal WDOT (testnet / local dev)
└── MockPriceOracle.sol     — Owner-settable DOT/USD price feed (testnet)
```

### LendingPool contract

**Key functions:**

| Function                   | Description                                                     |
|----------------------------|-----------------------------------------------------------------|
| `depositCollateral(amount)`| Deposit WDOT — increases your borrowing power                   |
| `borrowStablecoin(amount)` | Borrow MockUSDC — requires ≥ 150% collateral ratio             |
| `repayLoan(amount)`        | Repay principal + accrued interest (overpayment is capped)      |
| `withdrawCollateral(amount)`| Withdraw WDOT (position must remain ≥ 150% collateralised)    |
| `liquidate(borrower)`      | Liquidate a position below 120% ratio; receive 5% bonus        |
| `getHealthFactor(user)`    | View health factor (≥ 1e18 = safe)                             |
| `getUserPosition(user)`    | View collateral, debt, and health factor                        |

**Health Factor formula:**

```
HF = (collateralValueUSD × 100 × 1e18) / (debtValueUSD × 120)

HF ≥ 1e18  →  position is safe
HF <  1e18  →  position is liquidatable
```

**Interest accrual:**
Simple interest, settled lazily on every state-changing call:
```
interest = principal × 10% × timeElapsed / (365 days × 100)
```

---

## Installation

```bash
git clone <repo-url>
cd stbl-lend
npm install
cp .env.example .env
```

---

## Running Tests

```bash
npx hardhat test
```

The test suite covers:
- Deployment
- `depositCollateral` (basic, multiple, zero-amount revert)
- `borrowStablecoin` (happy path, over-borrow, no collateral, cumulative borrows)
- `repayLoan` (partial, full, overpayment cap, no-debt revert)
- `withdrawCollateral` (safe partial, breach revert, full after repay)
- `liquidate` (undercollateralised, healthy revert, double-liquidation, residual returned)
- `getHealthFactor` (no debt, after borrow, price drop)
- Interest accrual (1 year, 6 months, multi-period)
- Edge cases (two users, re-borrow cycle)

---

## Deploying

### Local (Hardhat node)

```bash
# Terminal 1 — start local node
npx hardhat node

# Terminal 2 — deploy (all mocks auto-deployed)
npx hardhat run scripts/deploy.ts --network localhost
```

### Polkadot Hub Testnet (Westend Asset Hub)

1. Fill in your `.env`:
   ```
   PRIVATE_KEY=<your key>
   RPC_URL=https://westend-asset-hub-eth-rpc.polkadot.io
   ```
   Optionally set `WDOT_ADDRESS`, `USDC_ADDRESS`, `ORACLE_ADDRESS` if tokens already exist.

2. Fund your wallet with testnet WND tokens via the [Polkadot faucet](https://faucet.polkadot.io/).

3. Deploy:
   ```bash
   npx hardhat run scripts/deploy.ts --network polkadot-hub-testnet
   ```
   The script will:
   - Deploy `MockWDOT`, `MockUSDC`, and `MockPriceOracle` if addresses are not set in `.env`
   - Deploy `LendingPool`
   - Seed the pool with 100,000 MockUSDC liquidity (testnet only)

### Network details

| Network                   | Chain ID   | RPC                                              |
|---------------------------|------------|--------------------------------------------------|
| Westend Asset Hub testnet | 420420421  | `https://westend-asset-hub-eth-rpc.polkadot.io`  |

---

## Frontend

A React + Vite scaffold lives in `frontend/`. To run it (after installing its own deps):

```bash
cd frontend
npm install
npm run dev
```

Update the contract addresses in `frontend/src/App.tsx` after deploying.

---

## Security Notes

- All token transfers use **SafeERC20**
- **ReentrancyGuard** on all external state-changing functions (CEI pattern inside `liquidate`)
- **Ownable** for admin functions (oracle price updates, mock minting)
- Solidity 0.8 native overflow protection — no SafeMath
- Oracle price is intentionally settable for testnet; swap `MockPriceOracle` with a Chainlink
  feed (or any `IPriceOracle`-compatible contract) for production

---

## License

MIT
