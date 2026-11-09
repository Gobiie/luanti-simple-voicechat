#!/usr/bin/env bash
# Generates a self-signed certificate so the panel can use HTTPS locally.
# Browsers only allow microphone access on HTTPS or localhost, and a
# self-signed certificate must be trusted before it counts as HTTPS.
#
# Usage: ./scripts/make-cert.sh [outdir] [hostname]
set -euo pipefail

out="${1:-certs}"
host="${2:-localhost}"
days="${3:-365}"

command -v openssl >/dev/null 2>&1 || {
	echo "openssl is required" >&2
	exit 1
}

mkdir -p "$out"

openssl req -x509 -newkey rsa:2048 -nodes \
	-keyout "$out/key.pem" \
	-out "$out/cert.pem" \
	-days "$days" \
	-subj "/CN=$host" \
	-addext "subjectAltName=DNS:$host,IP:127.0.0.1" \
	2>/dev/null

echo "wrote $out/cert.pem and $out/key.pem for $host"
echo "set in relay/config.json:  \"tls\": { \"cert\": \"certs/cert.pem\", \"key\": \"certs/key.pem\" }"
