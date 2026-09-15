# Hyperledger Besu QBFT Network (Self-Contained Docker Setup)

This repository contains a zero-configuration, cross-platform **Hyperledger Besu QBFT private blockchain network**. It runs a two-node cluster (`validator` + `peer`) via Docker Compose, eliminating the single-validator sync deadlock and providing an immediate zero-gas RPC endpoint.

---

## 📋 Prerequisites

1. **Docker Desktop** installed on your system.
   - **Windows Users**: Ensure **WSL 2 Backend** is enabled in Docker Desktop settings:
     `Settings -> General -> Use the WSL 2 based engine`.
2. **Git** (or download and extract this directory as a ZIP file).

---

## 🚀 Quick Start (Single Command)

Open your terminal (PowerShell or Command Prompt on Windows) in this folder and run:

```bash
docker compose up -d
```

That's it! Docker Compose will pull Hyperledger Besu `24.12.2`, initialize both node containers, establish a direct P2P link between them, and start mining blocks automatically.

---

## 🔍 How to Verify It Is Working

### 1. Check Container Logs for P2P Connection & Block Mining

Run the following command to observe the validator's log output:

```bash
docker compose logs -f validator
```

**What to look for in the logs**:
- **Peer Connection**: Look for a log line indicating a successful P2P connection:
  ```text
  INFO | P2P peer connected: enode://c935d069... @peer:30303
  ```
- **Block Mining**: Look for QBFT consensus producing new blocks every 2 seconds:
  ```text
  INFO | Import block #1 / 0 tx / 0 gas / (0x...)
  INFO | Import block #2 / 0 tx / 0 gas / (0x...)
  ```

### 2. Verify RPC & Block Increment via Command Line

#### **On Windows (PowerShell)**:

Check current peer count (should return `"0x1"` for 1 connected peer):
```powershell
Invoke-RestMethod -Uri "http://localhost:8545" -Method Post -ContentType "application/json" -Body '{"jsonrpc":"2.0","method":"net_peerCount","params":[],"id":1}'
```

Check current block number (run twice, value should increase e.g. `"0x1"`, `"0x2"`, `"0x5"`):
```powershell
Invoke-RestMethod -Uri "http://localhost:8545" -Method Post -ContentType "application/json" -Body '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

#### **On Linux / macOS (cURL)**:
```bash
curl -s -X POST "http://localhost:8545" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

---

## 🛠️ Management Commands

- **Stop the network** (preserves blockchain state):
  ```bash
  docker compose stop
  ```
- **Resume the network**:
  ```bash
  docker compose start
  ```
- **Completely reset the network** (wipes all block data and restarts clean from genesis):
  ```bash
  docker compose down -v
  docker compose up -d
  ```

---

## ❓ Troubleshooting

### Problem: Node is stuck at `Unable to find sync target` or `Waiting for consensus client`
- **Cause**: The validator node cannot reach its peer on the Docker network.
- **Solution**:
  1. Check both container statuses: `docker compose ps`
  2. Inspect peer container logs: `docker compose logs peer`
  3. Reset networks and named volumes: `docker compose down -v && docker compose up -d`

### Problem: Line ending errors on Windows (`\r\n` vs `\n`)
- **Fix Included**: This repository contains a `.gitattributes` file enforcing `LF` line endings. If manually editing `.key` or `.json` files on Windows, ensure your editor (VS Code, Notepad++) is set to **LF** line endings.