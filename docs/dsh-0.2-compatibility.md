# DSH 0.2 compatibility

This release requires DSH 0.2.1-alpha.1 or a compatible 0.2 release. The verified upstream revision is 5badb15009ae1756c3afe0ae0cef1faafc290ccc.

The installer removes official packages deleted by upstream. Environment export reads profile configuration after settings.yaml is imported; import preserves machine-local paths and writes the profile configuration without recreating settings.yaml.

Install the fixed commit reachable from the repository main branch through dsh plugin. The shared environment stores full commit ids; local source paths are not portable plugin pins.

The maintenance lockfile disables implicit peer installation and uses the current Cordis and schemastery versions. Git packages build without depending on the source checkout node_modules.

Legacy shared settings map onboarding and Jev to their current entry ids. The retired blue-theme selector is omitted; the installed blue foundation and ui-theme preference remain authoritative.
