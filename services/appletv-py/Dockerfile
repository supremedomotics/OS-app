# Supreme Apple TV bridge (Python/FastAPI + pyatv).
# Build context is the monorepo root (see docker-compose.yml) so the egress-proxy
# CA can be trusted for pip behind a TLS-intercepting proxy.
FROM python:3.11-slim
# Trust the environment's egress-proxy CA when present (no-op on normal networks).
COPY infra/hub-compose/ca-certs/ /usr/local/share/ca-certificates/
RUN for f in /usr/local/share/ca-certificates/*.crt; do [ -f "$f" ] && cat "$f" && echo; done > /usr/local/share/proxy-ca.pem 2>/dev/null || true
WORKDIR /app
COPY services/appletv-py/pyproject.toml ./
# Install the real pyatv stack (MRP/AirPlay/Companion). Use the proxy CA for pip only
# when one was provided; otherwise pip uses its default certifi bundle.
RUN [ -s /usr/local/share/proxy-ca.pem ] && export PIP_CERT=/usr/local/share/proxy-ca.pem; \
    pip install --no-cache-dir fastapi "uvicorn[standard]" pydantic "pyatv>=0.14.5"
COPY services/appletv-py/app ./app
# Credentials persist here (mount a volume in compose so pairing survives restarts).
VOLUME ["/data"]
EXPOSE 9300
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "9300"]
