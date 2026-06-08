#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[1;32m'
YELLOW='\033[1;33m'
CYAN='\033[1;36m'
NC='\033[0m'

clear
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}   SISTEMA FINANZAS VIP - INSTALADOR    ${NC}"
echo -e "${CYAN}========================================${NC}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker no está instalado. Instala Docker antes de continuar."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose no está disponible. Instala el plugin docker compose."
  exit 1
fi

if [ ! -f backend/.env ]; then
  echo -e "${YELLOW}Creando backend/.env desde backend/.env.prod...${NC}"
  cp backend/.env.prod backend/.env
  echo -e "${YELLOW}⚠ Edita backend/.env y reemplaza los CHANGE_ME antes de exponerlo a internet.${NC}"
  echo -e "${YELLOW}  (Para una instalación completa y segura usa: sudo bash install.sh)${NC}"
fi

echo -e "${YELLOW}Construyendo y levantando servicios...${NC}"
docker compose up -d --build

echo -e "${GREEN}Listo.${NC}"
echo "Frontend: http://localhost"
echo "API:      http://localhost:4000/api/health"
echo "BD:       conecta tu pgAdmin local a 127.0.0.1:5437"
