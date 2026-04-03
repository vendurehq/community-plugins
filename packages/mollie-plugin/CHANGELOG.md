# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## 1.0.0 (2026-03-30)

Initial release as `@vendure-community/mollie-plugin`, extracted from `@vendure/payments-plugin`.
Equivalent to the functionality in Vendure core v3.5.6, plus the following changes from the v3.6.0 development branch:

### Features

* **mollie-plugin:** add `syncMolliePaymentStatus` mutation for manual status sync when webhooks are delayed ([#4104](https://github.com/vendurehq/vendure/pull/4104))
* **mollie-plugin:** add `disableWebhookProcessing` plugin option ([#4104](https://github.com/vendurehq/vendure/pull/4104))
* **mollie-plugin:** allow overriding `immediateCapture` at plugin level ([#4142](https://github.com/vendurehq/vendure/pull/4142))

### Refactors

* **mollie-plugin:** rename `handleMollieStatusUpdate` to `handleMolliePaymentStatus` with improved order state handling ([#4104](https://github.com/vendurehq/vendure/pull/4104))
