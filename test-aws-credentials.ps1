# AWS Credentials Quick Test
# This script helps you quickly test different AWS authentication methods

param(
    [Parameter(Mandatory=$false)]
    [ValidateSet('profile', 'sso', 'env', 'mock')]
    [string]$Method = 'profile',
    
    [Parameter(Mandatory=$false)]
    [string]$ProfileName = 'default'
)

Write-Host "`n🔐 AWS Credentials Quick Test`n" -ForegroundColor Cyan

switch ($Method) {
    'profile' {
        Write-Host "Testing with AWS Profile: $ProfileName`n" -ForegroundColor Yellow
        $env:AWS_PROFILE = $ProfileName
        
        Write-Host "Checking AWS configuration..." -ForegroundColor Blue
        aws configure list --profile $ProfileName
        
        Write-Host "`nTesting S3 access..." -ForegroundColor Blue
        aws s3 ls s3://dev-service-optimisation-c63f2 --profile $ProfileName
        
        if ($LASTEXITCODE -eq 0) {
            Write-Host "`n✅ Profile '$ProfileName' is working!`n" -ForegroundColor Green
            Write-Host "To use this profile, add to your .env file:" -ForegroundColor Yellow
            Write-Host "AWS_PROFILE=$ProfileName`n" -ForegroundColor White
            
            # Test with Node.js script
            Write-Host "Running Node.js credential test..." -ForegroundColor Blue
            node test-aws-credentials.js
        } else {
            Write-Host "`n❌ Profile '$ProfileName' failed. Try:" -ForegroundColor Red
            Write-Host "  aws configure --profile $ProfileName`n" -ForegroundColor Yellow
        }
    }
    
    'sso' {
        Write-Host "Testing with AWS SSO: $ProfileName`n" -ForegroundColor Yellow
        
        Write-Host "Logging in to SSO..." -ForegroundColor Blue
        aws sso login --profile $ProfileName
        
        if ($LASTEXITCODE -eq 0) {
            Write-Host "`nTesting S3 access..." -ForegroundColor Blue
            aws s3 ls s3://dev-service-optimisation-c63f2 --profile $ProfileName
            
            if ($LASTEXITCODE -eq 0) {
                Write-Host "`n✅ SSO profile '$ProfileName' is working!`n" -ForegroundColor Green
                $env:AWS_PROFILE = $ProfileName
                
                Write-Host "To use this profile, add to your .env file:" -ForegroundColor Yellow
                Write-Host "AWS_PROFILE=$ProfileName`n" -ForegroundColor White
                
                # Test with Node.js script
                Write-Host "Running Node.js credential test..." -ForegroundColor Blue
                node test-aws-credentials.js
            }
        } else {
            Write-Host "`n❌ SSO login failed. Try:" -ForegroundColor Red
            Write-Host "  aws configure sso --profile $ProfileName`n" -ForegroundColor Yellow
        }
    }
    
    'env' {
        Write-Host "Testing with environment variables`n" -ForegroundColor Yellow
        
        if ($env:AWS_ACCESS_KEY_ID -and $env:AWS_SECRET_ACCESS_KEY) {
            $maskedKey = $env:AWS_ACCESS_KEY_ID.Substring(0, [Math]::Min(8, $env:AWS_ACCESS_KEY_ID.Length)) + "***"
            Write-Host "Found credentials: $maskedKey" -ForegroundColor Green
            
            Write-Host "`nTesting S3 access..." -ForegroundColor Blue
            aws s3 ls s3://dev-service-optimisation-c63f2
            
            if ($LASTEXITCODE -eq 0) {
                Write-Host "`n✅ Environment credentials are working!`n" -ForegroundColor Green
                
                # Test with Node.js script
                Write-Host "Running Node.js credential test..." -ForegroundColor Blue
                node test-aws-credentials.js
            }
        } else {
            Write-Host "❌ AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY not set" -ForegroundColor Red
            Write-Host "`nTo use environment variables, set:" -ForegroundColor Yellow
            Write-Host "`$env:AWS_ACCESS_KEY_ID = 'your-key-id'" -ForegroundColor White
            Write-Host "`$env:AWS_SECRET_ACCESS_KEY = 'your-secret-key'`n" -ForegroundColor White
        }
    }
    
    'mock' {
        Write-Host "Setting up MOCK mode (no AWS required)`n" -ForegroundColor Yellow
        
        if (Test-Path .env) {
            $envContent = Get-Content .env
            if ($envContent -match "MOCK_S3_UPLOAD") {
                Write-Host "MOCK_S3_UPLOAD already set in .env" -ForegroundColor Green
            } else {
                Add-Content .env "`nMOCK_S3_UPLOAD=true"
                Write-Host "✅ Added MOCK_S3_UPLOAD=true to .env" -ForegroundColor Green
            }
        } else {
            Copy-Item .env.example .env
            Add-Content .env "`nMOCK_S3_UPLOAD=true"
            Write-Host "✅ Created .env with MOCK_S3_UPLOAD=true" -ForegroundColor Green
        }
        
        Write-Host "`nMock mode enabled! Files will be simulated.`n" -ForegroundColor Green
        Write-Host "Start the backend with: npm start`n" -ForegroundColor Yellow
    }
}

Write-Host "`n📚 For more help, see:" -ForegroundColor Cyan
Write-Host "  - QUICK_START.md - 5-minute setup guide" -ForegroundColor White
Write-Host "  - AWS_SETUP_GUIDE.md - Detailed configuration" -ForegroundColor White
Write-Host "  - AWS_CONFIG_SUMMARY.md - Quick reference`n" -ForegroundColor White
