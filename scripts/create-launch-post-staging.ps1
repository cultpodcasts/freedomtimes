param(
    [Parameter(Mandatory = $true)]
    [string]$VideosPath,

    [Parameter(Mandatory = $true)]
    [string]$MarkdownPath,

    [string]$StagingUrl = "https://staging.freedomtimes.news",

    [string]$Token = $env:EMDASH_STAGING_PAT
)

if (-not $Token) {
    throw "EMDASH_STAGING_PAT environment variable not set. Run scripts\set-emdash-mcp-tokens.ps1 first."
}

# Change to web directory for npx
Push-Location "c:\Users\jonbr\source\repos\freedomtimes-branch2\web"

# Upload videos
$mediaMap = @{}
$videoFiles = Get-ChildItem -Path $VideosPath -Filter *.mp4
foreach ($video in $videoFiles) {
    $altText = [System.IO.Path]::GetFileNameWithoutExtension($video.Name)
    Write-Host "Uploading $($video.FullName) with alt: $altText"
    $uploadOutput = & npx emdash media upload $video.FullName -u $StagingUrl -t $Token --alt $altText --json
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to upload $($video.Name): $uploadOutput"
    }
    $mediaJson = $uploadOutput | ConvertFrom-Json
    $mediaMap[$video.Name] = $mediaJson
    Write-Host "Uploaded $($video.Name) -> ID: $($mediaJson.id), URL: $($mediaJson.url)"
}

# Convert markdown to Portable Text
$markdownContent = Get-Content -Path $MarkdownPath -Raw

# Parse title from first # line
$lines = ($markdownContent -replace "`r`n", "`n" -replace "`r", "`n") -split "`n"
$title = ""
$excerpt = ""
$contentStart = 0

for ($i = 0; $i -lt $lines.Length; $i++) {
    $line = $lines[$i].Trim()
    if ($line -match '^#\s+(.+)$') {
        $title = $matches[1]
        $contentStart = $i + 1
        break
    }
}

if (-not $title) {
    throw "Markdown file must start with a # title."
}

$title = "PBCC Plymouth-Brethren Cult: " + $title

# Find excerpt: first paragraph after title
for ($i = $contentStart; $i -lt $lines.Length; $i++) {
    $line = $lines[$i].Trim()
    if ($line -and -not $line.StartsWith('#') -and -not $line.StartsWith('[') -and -not $line.StartsWith('!')) {
        $excerpt = $line
        $contentStart = $i + 1
        break
    }
}

if (-not $excerpt) {
    throw "Could not find excerpt paragraph."
}

# Convert markdown body to Portable Text blocks.
# Supports headings and inline links to .mp4 (any link label, not just [clip]).
$portableText = @()
$contentLines = if ($contentStart -lt $lines.Length) { $lines[$contentStart..($lines.Length - 1)] } else { @() }

function Add-TextPortableBlock {
    param(
        [string]$Text,
        [string]$Style = "normal"
    )
    $clean = $Text.Trim()
    if (-not $clean) {
        return
    }
    $script:portableText += @{
        _type = "block"
        style = $Style
        children = @(@{
            _type = "span"
            text = $clean
        })
    }
}

function Add-VideoPortableBlock {
    param(
        [string]$FileName
    )
    $candidates = @($FileName)
    if ($FileName -notmatch '\.optimized\.mp4$') {
        $candidates += ($FileName -replace '\.mp4$', '.optimized.mp4')
    }

    $media = $null
    foreach ($candidate in $candidates) {
        if ($mediaMap.ContainsKey($candidate)) {
            $media = $mediaMap[$candidate]
            break
        }
    }

    if (-not $media) {
        Write-Warning "Video not found in uploaded media map: $FileName"
        return
    }

    $script:portableText += @{
        _type = "video"
        asset = @{
            _ref = $media.id
        }
        file = $media.url
        alt = if ($media.alt) { $media.alt } else { [System.IO.Path]::GetFileNameWithoutExtension($media.filename) }
    }
}

function Add-ParagraphWithInlineVideos {
    param(
        [string]$ParagraphText
    )
    $trimmed = $ParagraphText.Trim()
    if (-not $trimmed) {
        return
    }

    $videoLinkPattern = '\[[^\]]+\]\(([^)\s]+\.mp4)\)'
    $matches = [regex]::Matches($trimmed, $videoLinkPattern)

    if ($matches.Count -eq 0) {
        Add-TextPortableBlock -Text $trimmed
        return
    }

    $cursor = 0
    foreach ($match in $matches) {
        $beforeLength = $match.Index - $cursor
        if ($beforeLength -gt 0) {
            $beforeText = $trimmed.Substring($cursor, $beforeLength)
            Add-TextPortableBlock -Text $beforeText
        }

        $videoPath = $match.Groups[1].Value
        $videoFilename = [System.IO.Path]::GetFileName($videoPath)
        Add-VideoPortableBlock -FileName $videoFilename
        $cursor = $match.Index + $match.Length
    }

    if ($cursor -lt $trimmed.Length) {
        $remaining = $trimmed.Substring($cursor)
        Add-TextPortableBlock -Text $remaining
    }
}

$paragraphLines = @()
foreach ($rawLine in $contentLines) {
    $line = $rawLine.TrimEnd()
    $headingMatch = [regex]::Match($line.Trim(), '^(#{2,4})\s+(.+)$')

    if (-not [string]::IsNullOrWhiteSpace($line) -and $headingMatch.Success) {
        if ($paragraphLines.Count -gt 0) {
            Add-ParagraphWithInlineVideos -ParagraphText (($paragraphLines -join " ").Trim())
            $paragraphLines = @()
        }
        $level = $headingMatch.Groups[1].Value.Length
        $style = "h$level"
        Add-TextPortableBlock -Text $headingMatch.Groups[2].Value -Style $style
        continue
    }

    if ([string]::IsNullOrWhiteSpace($line)) {
        if ($paragraphLines.Count -gt 0) {
            Add-ParagraphWithInlineVideos -ParagraphText (($paragraphLines -join " ").Trim())
            $paragraphLines = @()
        }
        continue
    }

    $paragraphLines += $line.Trim()
}

if ($paragraphLines.Count -gt 0) {
    Add-ParagraphWithInlineVideos -ParagraphText (($paragraphLines -join " ").Trim())
}

# Create post data
$postData = @{
    title = $title
    excerpt = $excerpt
    content = $portableText
}

# Convert to JSON
$postJson = $postData | ConvertTo-Json -Depth 10

# Create post
Write-Host "Creating post with title: $title"
$createOutput = $postJson | & npx emdash content create posts -u $StagingUrl -t $Token --stdin --json
if ($LASTEXITCODE -ne 0) {
    throw "Failed to create post: $createOutput"
}

$postResult = $createOutput | ConvertFrom-Json

# Output summary
$summary = @{
    post = @{
        id = $postResult.id
        slug = $postResult.slug
        url = "$StagingUrl/posts/$($postResult.slug)"
    }
    media = $mediaMap
}

$summary | ConvertTo-Json -Depth 10 | Out-File -FilePath "launch-summary.json" -Encoding UTF8

Write-Host "Post created successfully. Summary saved to launch-summary.json"

Pop-Location