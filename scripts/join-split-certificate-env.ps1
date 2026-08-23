# Join Cloud Agent / secret-store splits of oversized PFX base64 into the
# canonical TF_VAR names Terraform remapping expects.
# Concatenates in process memory only. Does not log secret values.

function Join-SplitCustomHostnameCertificateEnvVars {
    $names = @(
        "TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_BASE64_STAGING",
        "TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_BASE64_PRODUCTION"
    )

    foreach ($name in $names) {
        $current = [System.Environment]::GetEnvironmentVariable($name, "Process")
        if (-not [string]::IsNullOrWhiteSpace($current)) {
            continue
        }

        $part1 = [System.Environment]::GetEnvironmentVariable("${name}_1", "Process")
        $part2 = [System.Environment]::GetEnvironmentVariable("${name}_2", "Process")
        if ([string]::IsNullOrWhiteSpace($part1) -or [string]::IsNullOrWhiteSpace($part2)) {
            continue
        }

        [System.Environment]::SetEnvironmentVariable($name, ($part1 + $part2), "Process")
        Write-Host "Joined ${name}_1 and ${name}_2 into $name (in memory)." -ForegroundColor DarkGray
    }
}
