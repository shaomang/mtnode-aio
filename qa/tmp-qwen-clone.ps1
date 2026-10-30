$ErrorActionPreference = 'Stop'
$root = 'E:\dev\tools\pipeline-console'

$pairs = @(
  @('flux3klein-workflows.js','qwenimage-workflows.js'),
  @('main-flux3klein.js','main-qwenimage.js'),
  @('preload-flux3klein.js','preload-qwenimage.js'),
  @('flux3klein-pack','qwenimage-pack'),
  @('flux3-klein-pack','qwenimage-pack'),
  @('flux3klein_gen','qwenimage_gen'),
  @('flux3klein','qwenimage'),
  @('Flux3Klein','QwenImage'),
  @('FLUX3KLEIN','QWENIMAGE'),
  @('flux3-klein-local','qwen-image-local'),
  @('flux3-klein-','qwen-image-'),
  @('flux3-klein','qwen-image'),
  @('FLUX 3 Image Klein','Qwen Image 2.1'),
  @('Flux 3 Image Klein','Qwen Image 2.1'),
  @('FLUX 3 Klein','Qwen Image 2.1'),
  @('flux3-image-klein-int8-convrot.safetensors','qwen_image_2.1_int8_convrot.safetensors'),
  @('flux3-image-klein-bf16.safetensors','qwen_image_2.1_turbo_int8_convrot.safetensors'),
  @('qwen3vl_4b_int8_convrot.safetensors','qwen3vl_8b_int8_convrot.safetensors'),
  @('qwen3vl_4b_bf16.safetensors','qwen3vl_8b_int8_convrot.safetensors'),
  @('flux2-vae.safetensors','@@VAE@@'),
  @('black-forest-labs/flux-3-image-klein-comfy','Comfy-Org/Qwen-Image-2.1'),
  @('ml-resources/flux-3-image-klein-comfy','Comfy-Org/Qwen-Image-2.1'),
  @('8197','8196'),
  @('SkipBf16','SkipTurbo'),
  @('skipBf16','skipTurbo'),
  @('bf16','turbo'),
  @('Bf16','Turbo'),
  @('BF16','Turbo INT8'),
  @('@@VAE@@','qwen_image_2.1_vae_bf16.safetensors')
)
function Convert-Text([string]$text) {
  foreach ($pair in $pairs) { $text = $text.Replace($pair[0], $pair[1]) }
  return $text
}

function Copy-Transformed([string]$src, [string]$dst) {
  $text = [System.IO.File]::ReadAllText($src)
  [System.IO.File]::WriteAllText($dst, (Convert-Text $text), (New-Object System.Text.UTF8Encoding($false)))
  Write-Output ("wrote " + $dst)
}

New-Item -ItemType Directory -Force -Path (Join-Path $root 'qwenimage\ui') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $root 'qwenimage-pack\scripts') | Out-Null

Copy-Transformed (Join-Path $root 'flux3klein\main-flux3klein.js') (Join-Path $root 'qwenimage\main-qwenimage.js')
Copy-Transformed (Join-Path $root 'flux3klein\preload-flux3klein.js') (Join-Path $root 'qwenimage\preload-qwenimage.js')
foreach ($f in @('index.html', 'ui.css', 'ui.js')) {
  Copy-Transformed (Join-Path $root "flux3klein\ui\$f") (Join-Path $root "qwenimage\ui\$f")
}
Copy-Transformed (Join-Path $root 'renderer\app-flux3klein.js') (Join-Path $root 'renderer\app-qwenimage.js')
foreach ($f in @('manifest.json', 'README.md', 'requirements.txt', 'start_backend.cmd', 'steps.json', '.gitignore')) {
  Copy-Transformed (Join-Path $root "flux3klein-pack\$f") (Join-Path $root "qwenimage-pack\$f")
}
foreach ($f in @('install.ps1', 'step.ps1')) {
  Copy-Transformed (Join-Path $root "flux3klein-pack\scripts\$f") (Join-Path $root "qwenimage-pack\scripts\$f")
}

