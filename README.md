# 📞 AutoLead Showcaser
### LAN-based Auto Lead Dialing System — Node.js

---

## Features
- **Admin Panel**: Upload Excel/CSV files of phone numbers
- **Auto Distribution**: Numbers assigned to agents one-by-one, never repeated
- **Agent Dialer**: Clean UI showing one number at a time — no skip button
- **Daily Auto-Reset**: Counts reset at midnight automatically
- **Live Stats**: Admin sees remaining, dialed, agents active — all real-time
- **LAN Network**: Runs on your local network, accessible from any device

---

## Setup & Run

### 1. Install Node.js
Download from: https://nodejs.org (LTS version)

### 2. Extract project folder

### 3. Install dependencies
```
cd autolead
npm install
```

### 4. Start the server
```
npm start
```

### 5. Find your LAN IP
- **Windows**: Run `ipconfig` → look for IPv4 Address (e.g. 192.168.1.10)
- **Mac/Linux**: Run `ifconfig` or `ip addr`

### 6. Share URLs with your team
| Role  | URL |
|-------|-----|
| Admin | http://YOUR-LAN-IP:3000/admin |
| Agent | http://YOUR-LAN-IP:3000/agent |

---

## How to Use

### Admin
1. Open `/admin` in your browser
2. Upload an Excel (.xlsx) or CSV file — Column A must contain phone numbers
3. Watch the stats update as agents dial
4. Upload multiple files — they all go into one pool

### Agent
1. Open `/agent` on their device (phone or PC)
2. Enter their name and log in
3. Press **Start Dialing** — a number appears
4. Dial the number, then press **✓ Dialed — Next Number**
5. Repeat! Daily count is shown on screen

---

## Excel/CSV Format
```
Column A
----------
9876543210
9123456789
8800001234
...
```
Header row (if any) is auto-skipped.

---

## Auto-Reset
Every midnight, daily dial counts reset to 0 automatically.
Numbers are re-available the next day (unless deleted).

---

## Port Change
Edit `server.js` line: `const PORT = 3000;`
