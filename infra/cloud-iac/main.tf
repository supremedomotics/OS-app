# Supreme Cloud — OPTIONAL control plane infrastructure (§5, §8, §13).
#
# Cloud-agnostic skeleton: it provisions a container host running the cloud
# docker-compose (relay + fleet + otel-collector + prometheus), a managed Postgres for
# cloud state, DNS, and the relay/push secrets. Swap the example resources for your
# provider (AWS ECS/Fargate, GCP Cloud Run, Hetzner, etc.). The hub is local-first, so
# none of this is on the critical path for in-home control.
#
# Validate locally: `terraform init && terraform fmt -check && terraform validate`.

terraform {
  required_version = ">= 1.6.0"
  required_providers {
    # Replace with your cloud provider. `random` is used for generated secrets.
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "random" {}

# The shared secret hubs present to the relay (tunnel + push). Distribute to hubs via
# their sealed secret store as SUPREME_RELAY_TOKEN / SUPREME_PUSH_RELAY_TOKEN.
resource "random_password" "relay_token" {
  length  = 48
  special = false
}

# The cloud Postgres password (fleet/licensing state).
resource "random_password" "db_password" {
  length  = 32
  special = false
}

locals {
  cloud_env = {
    SUPREME_RELAY_TOKEN = random_password.relay_token.result
    POSTGRES_PASSWORD   = random_password.db_password.result
    SUPREME_DOMAIN      = var.domain
  }
}

# ── Replace the modules below with real provider resources ──────────────────────────
# module "network"  { source = "./modules/network" ... }
# module "database"  { source = "./modules/postgres" password = random_password.db_password.result ... }
# module "compute"   { source = "./modules/compute"  env = local.cloud_env ... }   # runs cloud-compose
# module "dns"       { source = "./modules/dns"      domain = var.domain ... }      # relay.<domain>, fleet.<domain>
# module "tls"       { source = "./modules/tls"      domain = var.domain ... }      # ACME / managed cert
