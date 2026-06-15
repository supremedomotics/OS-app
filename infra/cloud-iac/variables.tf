# Inputs for the Supreme Cloud control plane.
variable "domain" {
  description = "Apex domain for the cloud plane (relay.<domain>, fleet.<domain>)."
  type        = string
  default     = "cloud.supreme.example"
}

variable "region" {
  description = "Provider region for the compute + database."
  type        = string
  default     = "eu-central-1"
}

variable "hub_count_hint" {
  description = "Rough number of hubs to size relay/db capacity for."
  type        = number
  default     = 100
}
