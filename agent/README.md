# Luminous Neo Agent (Windows)

This user-level agent polls Luminous for jobs assigned to its device. It connects only to the local BrowserOS Neo MCP endpoint. Connection tests list tools and count tabs. Browser jobs call the selected Neo tool and send a bounded text response back to Luminous. A browser job runs only after it is explicitly queued; an expired job is not repeated automatically.

## Install

1. Open BrowserOS Neo. The installer checks for Node.js 22 or newer and installs Node.js LTS with `winget` when needed. If `winget` is unavailable, install Node.js LTS manually first.
2. In Luminous Profile, create a device for the store and copy the one-time token.
3. In Neo's MCP connection screen, copy its local `/mcp` URL.
4. Download this repository, then run `powershell -ExecutionPolicy Bypass -File .\agent\install.ps1` from its root.

The installer asks for the Luminous HTTPS origin, Neo URL, and device token. It stores the token encrypted with Windows DPAPI for the current user, installs an at-logon task, and starts it. Keep the copied token private. Revoking the device in Luminous prevents further claims.

To run interactively after setup: `cd agent; npm start -- run`. To stop automatic starts, remove the Windows scheduled task `Luminous Neo Agent`.

## Update an existing installation

From the repository root, run `git pull origin main`, then `cd agent`, `npm.cmd ci`, `Stop-ScheduledTask -TaskName 'Luminous Neo Agent'`, and `Start-ScheduledTask -TaskName 'Luminous Neo Agent'`. The existing device token remains in the user's DPAPI configuration; do not create or share a new token for a code update. Verify the scheduled task is running after the restart.
