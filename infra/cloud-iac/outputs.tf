# Outputs consumed when configuring hubs + clients.
output "relay_token" {
  description = "Shared secret to set as SUPREME_RELAY_TOKEN on every hub."
  value       = random_password.relay_token.result
  sensitive   = true
}

output "relay_url" {
  description = "Base URL hubs dial for push + remote-access tunnel."
  value       = "https://relay.${var.domain}"
}

output "fleet_url" {
  description = "Installer fleet API base URL."
  value       = "https://fleet.${var.domain}"
}
