# OBSOLETO — el API Node+Mongo ya no se despliega.
# Usá:
#   .\scripts\deploy-firebase.ps1        → API + frontend (Firebase)
#   .\scripts\deploy-sr201-bridge.ps1    → puente hardware en planta
#
# El backend histórico está en legacy/backend-libro-guardia/

Write-Host @"

deploy-backend.ps1 está deprecado.

El backend de negocio es Firebase Cloud Functions.
  → .\scripts\deploy-firebase.ps1

El unico proceso local de planta es el puente SR201 (sin Mongo, sin usuarios):
  → .\scripts\deploy-sr201-bridge.ps1
  → .\scripts\setup-servidor.ps1

"@ -ForegroundColor Yellow

exit 1
