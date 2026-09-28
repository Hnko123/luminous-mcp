# Luminous Neo Agent (Windows)

This user-level agent polls Luminous for jobs assigned to its device. It connects only to the local BrowserOS Neo MCP endpoint. Connection tests list tools and count tabs. Browser jobs call the selected Neo tool and send a bounded text response back to Luminous. A browser job runs only after it is explicitly queued; an expired job is not repeated automatically.

## Install

Use the same Windows account that runs BrowserOS Neo. On a new computer with `winget` but no Git, open PowerShell and install Git:

```powershell
winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
```

Close PowerShell and open it again so Git is on `PATH`. Then download the agent:

```powershell
git --version
cd $env:USERPROFILE
git clone https://github.com/Hnko123/luminous-mcp.git
cd .\luminous-mcp
```

1. Open BrowserOS Neo on this computer. In Neo's MCP connection screen, copy its local `/mcp` URL (usually `http://127.0.0.1:9010/mcp`).
2. Sign in to Luminous as the user assigned to this computer. In **Profile → Neo mağaza cihazları**, create a device for the exact shop name and copy the one-time token. For Mustafa's Genie computer, use shop `GenieWishPendants` and label `Genie bilgisayarı`.
3. From the downloaded repository root, run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\agent\install.ps1
   ```

4. When prompted, enter the Luminous URL (`https://luminousluxurycrafts.com.tr`), the local Neo MCP URL, and the one-time device token. The installer checks for Node.js 22 or newer and installs Node.js LTS with `winget` when needed. If Node.js was just installed but is not found, open a new PowerShell window and rerun the installer.
5. In Luminous Profile, click **Bağlantıyı test et** for the new device and check that the test completes.

The installer stores the token encrypted with Windows DPAPI for the current user, installs an at-logon task, and starts it. Keep the token on this computer; do not paste it into chat, tickets, or logs. Revoking the device in Luminous prevents further claims.

To run interactively after setup: `cd agent; npm start -- run`. To stop automatic starts, remove the Windows scheduled task `Luminous Neo Agent`.

## Update an existing installation

From the repository root, run `git pull origin main`, then `cd agent`, `npm.cmd ci`, `Stop-ScheduledTask -TaskName 'Luminous Neo Agent'`, and `Start-ScheduledTask -TaskName 'Luminous Neo Agent'`. The existing device token remains in the user's DPAPI configuration; do not create or share a new token for a code update. Verify the scheduled task is running after the restart.
