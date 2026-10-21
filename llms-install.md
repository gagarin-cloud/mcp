# Installing the Gagarin MCP server

This is for an agent (Cline, or any other) setting Gagarin up for its human.
There is nothing to clone, build or run: the server is remote.

1. Add a remote MCP server with this URL, over streamable HTTP:

   ```
   https://mcp.gagarin.cloud/mcp
   ```

   In Cline, add it to `cline_mcp_settings.json`:

   ```json
   {
     "mcpServers": {
       "gagarin": {
         "type": "streamableHttp",
         "url": "https://mcp.gagarin.cloud/mcp"
       }
     }
   }
   ```

2. On first connect the server answers `401` and the client starts OAuth sign-in.
   Your human signs in with GitHub or Google in the browser that opens. There is
   no API key to ask for and no separate signup; a new account starts with $5 on
   it.

3. Call `whoami` to confirm which account you are acting as.

The tools can deploy an image that is already in Gagarin's registry, add
resources, wire dependencies, give a service an address, read logs and roll
back. They cannot build or push an image, because that needs docker and the
source on a machine. For that, install the `gg` CLI and the Gagarin skill as
https://gagarin.cloud/llms.txt describes, and use `gg ship`.

Deleting anything emails your human a button to approve, every time. Tell them
when a call is waiting on that rather than retrying it.
