# Build-time CA certificates (environment-specific, not committed)

If the build/run environment routes egress through a **TLS-intercepting proxy**
(e.g. the managed Claude Code web environment), package fetches inside Docker
builds (`pnpm`, `pip`) fail with "self-signed certificate in certificate chain"
because the container doesn't trust the proxy CA.

Drop the proxy's CA cert(s) (`*.crt`, PEM) into this directory and the Dockerfiles
will install them and trust them at build time. `scripts/dev/enable-native-tools.sh`
populates this automatically from the host trust store when a proxy CA is present.

On normal networks (CI/GitHub runners, real hubs) this directory is empty and the
Dockerfiles' CA step is a harmless no-op.
