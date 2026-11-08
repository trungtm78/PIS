#!/bin/sh
# Creates the backup bucket at the SECOND site with every immutability setting of infra/backup/backup-policy.json, through the AWS CLI against the
# S3 compatible object store of the customer. Run once, by the object store administrator (not by the backup writer), with that administrator's own credentials:
#
#   sh create-bucket.sh <bucket> <endpoint url> [region]
#
# Object lock can only be switched on when the bucket is created; COMPLIANCE mode cannot be shortened or removed by anyone until each object's retention ends.
set -eu

[ "$#" -ge 2 ] || { echo "usage: sh create-bucket.sh <bucket> <endpoint url> [region]" >&2; exit 2; }
BUCKET="$1"
ENDPOINT="$2"
REGION="${3:-vn-sgn-1}"
HERE=$(cd "$(dirname "$0")" && pwd)
S3="aws s3api --endpoint-url ${ENDPOINT} --region ${REGION}"

${S3} create-bucket --bucket "${BUCKET}" --object-lock-enabled-for-bucket
${S3} put-bucket-versioning --bucket "${BUCKET}" --versioning-configuration "file://${HERE}/versioning.json"
${S3} put-object-lock-configuration --bucket "${BUCKET}" --object-lock-configuration "file://${HERE}/object-lock-configuration.json"
${S3} put-bucket-encryption --bucket "${BUCKET}" --server-side-encryption-configuration "file://${HERE}/encryption.json"
${S3} put-public-access-block --bucket "${BUCKET}" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

echo "bucket ${BUCKET} created. Next: create the writer identity and attach writer-policy.json (BUCKET_NAME replaced), then run: node scripts/backup-verify.mjs live --bucket ${BUCKET} --endpoint ${ENDPOINT}"
