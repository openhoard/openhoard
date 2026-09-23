# ADR-0006: Storage abstraction: Apache OpenDAL

- Status: proposed
- Date: 2026-09-23
- Deciders: @RevBooyah
- Related: T-203

## Context

From the OpenHoard Dev Plan (stack decisions). One API for local disk, S3 and Azure Blob; S3 default, Azure first-class for Microsoft 365 customers.

## Decision

Use the OpenDAL Node binding for blob storage with fs, s3 and azblob backends.

## Options considered

- **Chosen:** Apache OpenDAL
- Direct AWS + Azure SDKs

## Consequences

Native binding must ship for Windows, macOS and Linux (it does).
