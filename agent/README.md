# Luminous Neo Agent (Windows)

This user-level agent polls Luminous for jobs assigned to its device. It connects only to the local BrowserOS Neo MCP endpoint. The first release only lists tools and counts tabs; it does not open pages or change Etsy.

## Install

1. Install Node.js 22 or newer and open BrowserOS Neo.
2. In Luminous Profile, create a device for the store and copy the one-time token.
3. In Neo's MCP connection screen, copy its local `/mcp` URL.
4. Download this repository, then run `powershell -ExecutionPolicy Bypass -File .\agent\install.ps1` from its root.

The installer asks for the Luminous HTTPS origin, Neo URL, and device token. It stores the token encrypted with Windows DPAPI for the current user, installs an at-logon task, and starts it. Keep the copied token private. Revoking the device in Luminous prevents further claims.

To run interactively after setup: `cd agent; npm start -- run`. To stop automatic starts, remove the Windows scheduled task `Luminous Neo Agent`.
