#!/usr/bin/env bash
# Rolls one environment to an image already pushed to its ECR (architecture §13.1, P8-Q12), from
# deploy.yml. Needs the AWS CLI (credentials from OIDC) and jq. Every input comes from the GitHub
# environment's variables (terraform output `deploy`), nothing is hard-coded:
#   IMAGE  ECS_CLUSTER  ECS_API_SERVICE  ECS_WORKER_SERVICE  ECS_API_FAMILY  ECS_WORKER_FAMILY
#   ECS_MIGRATE_FAMILY  ECS_SUBNET_IDS (comma-separated)  ECS_SECURITY_GROUP_ID  API_BASE_URL
#   SKIP_MIGRATIONS=true for a rollback (rollback.yml): an older image does not know the migrations
#   applied after it, and Knex refuses to run with them missing. Safe because migrations are
#   expand/contract: the older version keeps working on the newer schema (CLAUDE.md §6.1).
#
# 1. New task definition revisions (api, worker, migrate) = the latest revision with the new image.
#    Terraform owns everything else in them (env, secrets, sizes), deploy.yml only the image.
# 2. Migrations as a one-off task; a non-zero exit stops here, before any service changes (the old
#    version keeps running: migrations are expand/contract, CLAUDE.md §6.1).
# 3. Roll api and worker, wait until both are stable (the circuit breaker rolls back a failed start).
# 4. /health/ready over the public URL.
set -euo pipefail

: "${IMAGE:?}" "${ECS_CLUSTER:?}" "${ECS_API_SERVICE:?}" "${ECS_WORKER_SERVICE:?}" "${ECS_API_FAMILY:?}"
: "${ECS_WORKER_FAMILY:?}" "${ECS_MIGRATE_FAMILY:?}" "${ECS_SUBNET_IDS:?}" "${ECS_SECURITY_GROUP_ID:?}"
: "${API_BASE_URL:?}"

log() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }

# Registers <family>'s latest revision again with $IMAGE and prints the new revision's ARN.
register_with_image() {
  local family="$1"
  aws ecs describe-task-definition --task-definition "$family" --query taskDefinition --output json |
    jq --arg image "$IMAGE" '
      .containerDefinitions[0].image = $image
      | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities,
            .registeredAt, .registeredBy, .deregisteredAt)' >"/tmp/$family.json"
  aws ecs register-task-definition --cli-input-json "file:///tmp/$family.json" \
    --query taskDefinition.taskDefinitionArn --output text
}

log "image: $IMAGE"
api_task=$(register_with_image "$ECS_API_FAMILY")
worker_task=$(register_with_image "$ECS_WORKER_FAMILY")
migrate_task=$(register_with_image "$ECS_MIGRATE_FAMILY")
log "registered: $api_task $worker_task $migrate_task"

subnets=$(jq -cn --arg s "$ECS_SUBNET_IDS" '$s | split(",")')
network=$(jq -cn --argjson subnets "$subnets" --arg sg "$ECS_SECURITY_GROUP_ID" \
  '{awsvpcConfiguration: {subnets: $subnets, securityGroups: [$sg], assignPublicIp: "DISABLED"}}')

if [ "${SKIP_MIGRATIONS:-false}" = "true" ]; then
  log "migrations: skipped (rollback)"
else
  log "migrations: starting"
  migration=$(aws ecs run-task --cluster "$ECS_CLUSTER" --task-definition "$migrate_task" \
    --launch-type FARGATE --network-configuration "$network" --started-by deploy \
    --query 'tasks[0].taskArn' --output text)
  aws ecs wait tasks-stopped --cluster "$ECS_CLUSTER" --tasks "$migration"
  exit_code=$(aws ecs describe-tasks --cluster "$ECS_CLUSTER" --tasks "$migration" \
    --query 'tasks[0].containers[0].exitCode' --output text)
  if [ "$exit_code" != "0" ]; then
    log "migrations failed (exit code $exit_code): services left on the previous version"
    exit 1
  fi
  log "migrations: done"
fi

aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_API_SERVICE" --task-definition "$api_task" >/dev/null
aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_WORKER_SERVICE" --task-definition "$worker_task" >/dev/null
log "services: rolling"
aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services "$ECS_API_SERVICE" "$ECS_WORKER_SERVICE"
log "services: stable"

for attempt in 1 2 3 4 5; do
  if curl -fsS --max-time 10 "$API_BASE_URL/health/ready" >/dev/null; then
    log "ready: $API_BASE_URL/health/ready"
    exit 0
  fi
  log "not ready yet (attempt $attempt)"
  sleep 10
done
log "$API_BASE_URL/health/ready did not answer 200"
exit 1
