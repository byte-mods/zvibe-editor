# Managed Collaboration Relay

The relay lets an editor behind NAT create the only outbound WebSocket connection while remote clients submit authenticated collaboration requests through a deployable HTTP service.

Build and start it behind an HTTPS/WSS reverse proxy:

```bash
yarn build-mcp-server
BABYLON_EDITOR_RELAY_PROJECT_TOKENS='{"my-project":"replace-with-a-long-random-secret"}' \
BABYLON_EDITOR_RELAY_HOST=127.0.0.1 \
BABYLON_EDITOR_RELAY_PORT=8787 \
BABYLON_EDITOR_RELAY_PUBLIC_BASE_URL=https://relay.example \
yarn workspace babylonjs-editor-mcp-server relay
```

Configure the editor with `wss://relay.example/v1/editor`, project slug `my-project`, and the matching relay access token. Prefer the editor process environment variable named by `tokenEnvironmentVariable`; a token entered through the Scene Inspector or MCP is live-only and never persisted.

Remote clients send a collaboration session token obtained separately from a project administrator:

```bash
curl https://relay.example/v1/projects/my-project/request \
  -H 'Authorization: Bearer COLLABORATION_SESSION_TOKEN' \
  -H 'Content-Type: application/json' \
  --data '{"kind":"action","body":{"endpoint":"get_scene_hierarchy","data":{}}}'
```

Supported request kinds are `action`, `presence`, `events`, and `lock`. The relay does not authenticate project roles itself; it forwards the collaboration session token over WSS so the editor applies its existing central admin/editor/viewer policy. Deploy TLS at the reverse proxy, protect environment variables with the hosting platform's secret manager, and apply platform-level rate limiting in addition to the built-in per-address limit.
