# Use a loopback OAuth callback

The default DSH Web Host is used through `http://127.0.0.1:3080/`, with the
browser and Host on the same machine. Mail authorization therefore defaults to
the loopback redirect URI
`http://127.0.0.1:3080/oauth/dsh-mail/callback`, registered as a plugin-owned
WebServer route. Operators may provide a compatible HTTPS callback URL in the
Agent mailbox Settings card, keeping the exact `/oauth/dsh-mail/callback` pathname while changing
the origin or port (for example, through a reverse proxy). The Host retains the
one-time OAuth state and PKCE verifier, exchanges the callback code, and stores
the resulting credential without requiring a public DSH URL.
