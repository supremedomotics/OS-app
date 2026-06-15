# Supreme Cloud IaC (§5, §8)

Cloud-agnostic Terraform skeleton for the **optional** Supreme Cloud control plane.
The home hub is local-first and does not depend on any of this.

## What it provisions (once you fill in the provider modules)
- Compute running `infra/cloud-compose` (relay + fleet + otel-collector + prometheus)
- Managed Postgres for cloud state (fleet/licensing)
- DNS: `relay.<domain>`, `fleet.<domain>`
- Generated secrets: relay token, DB password

## Usage
```bash
terraform init
terraform fmt -check
terraform validate
terraform plan  -var "domain=cloud.yourco.com"
terraform apply -var "domain=cloud.yourco.com"
# Distribute the relay_token output to hubs as SUPREME_RELAY_TOKEN / SUPREME_PUSH_RELAY_TOKEN.
```

Replace the commented `module` blocks in `main.tf` with your provider's resources
(AWS ECS/Fargate, GCP Cloud Run, Hetzner + Nomad, etc.). Keep secrets in the provider's
secret manager, not in state where avoidable.
