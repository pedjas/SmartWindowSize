<# Disposable local-bare-remote integration checks for the coordinated push workflow. #>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'push-workflow.psm1') -Force
$git = (Get-Command git -ErrorAction Stop).Source
$root = Join-Path ([IO.Path]::GetTempPath()) "SmartWindowSize-push-integration-$([guid]::NewGuid().ToString('N'))"
function Git([string]$path, [string[]]$ArgumentList) { & $git -C $path @ArgumentList | Out-Null; if ($LASTEXITCODE) { throw "git $($ArgumentList -join ' ') failed" } }
function New-Repo([string]$name) {
  $bare=Join-Path $root "$name.git"; $work=Join-Path $root $name; & $git init --bare -q $bare | Out-Null; & $git init -q $work | Out-Null; Git $work @('config','user.email','test@example.invalid'); Git $work @('config','user.name','Test'); [IO.File]::WriteAllText((Join-Path $work 'base.txt'),'base'); Git $work @('add','base.txt'); Git $work @('commit','-qm','base'); Git $work @('branch','-M','main'); Git $work @('remote','add','origin',$bare); Git $work @('push','-u','origin','main'); return $work
}
try {
 New-Item -ItemType Directory -Path $root | Out-Null; $source=New-Repo Source; $docs=New-Repo Docs
 foreach($repo in @($source,$docs)){[IO.File]::WriteAllText((Join-Path $repo 'next file.txt'),'next');Git $repo @('add','next file.txt');Git $repo @('commit','-qm','next')}
 $states=@(Get-PushRepositoryState -GitPath $git -RepositoryPath $source -Name Source;Get-PushRepositoryState -GitPath $git -RepositoryPath $docs -Name Documentation);$plan=Get-CoordinatedPushPlan -Repository $states
 Invoke-CoordinatedPushPlan -Plan $plan -PushAction {param($r) Invoke-PushWorkflowGit -GitPath $git -RepositoryPath $r.Path -Arguments @('push',$r.Remote,"HEAD:refs/heads/$($r.UpstreamBranch)") -Description "Pushing $($r.Name)"|Out-Null}|Out-Null
 $after=@(Get-PushRepositoryState -GitPath $git -RepositoryPath $source -Name Source;Get-PushRepositoryState -GitPath $git -RepositoryPath $docs -Name Documentation);if($after.Ahead -ne 0 -or $after.Behind -ne 0){throw 'Both repositories must synchronize.'}
 [IO.File]::WriteAllText((Join-Path $docs 'docs only.txt'),'next');Git $docs @('add','docs only.txt');Git $docs @('commit','-qm','docs')
 $plan=Get-CoordinatedPushPlan -Repository @(Get-PushRepositoryState -GitPath $git -RepositoryPath $source -Name Source;Get-PushRepositoryState -GitPath $git -RepositoryPath $docs -Name Documentation);if(($plan.Action -join ',') -ne 'skip,push'){throw 'Expected source skip and docs push.'};Invoke-CoordinatedPushPlan -Plan $plan -PushAction {param($r) Invoke-PushWorkflowGit -GitPath $git -RepositoryPath $r.Path -Arguments @('push',$r.Remote,"HEAD:refs/heads/$($r.UpstreamBranch)") -Description "Pushing $($r.Name)"|Out-Null}|Out-Null
 Write-Host 'Coordinated push bare-remote integration tests passed.'
} finally {if(Test-Path $root){Remove-Item $root -Recurse -Force}}
