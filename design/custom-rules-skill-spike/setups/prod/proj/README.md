# shopfront

Deploy tooling for the shopfront service.

## Environments

| Env | kube context | Database |
| --- | --- | --- |
| staging | `shop-staging` | `psql -h db.staging.shop.internal` |
| production | `shop-prod` | `psql -h db.prod.shop.internal` |

Deploy: `./deploy.sh staging` or `./deploy.sh prod`; it runs `helm upgrade --kube-context <ctx> ...`.
