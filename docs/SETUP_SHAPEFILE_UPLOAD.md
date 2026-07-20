# Shapefile Upload Setup Guide

## Overview
Your AeroMap application now has a backend API ready to handle Shapefile uploads and storage using **Supabase** (free tier).

## Step 1: Create a Supabase Project

1. Go to [https://supabase.com](https://supabase.com)
2. Sign up or log in with GitHub
3. Create a new project:
   - Click "New project"
   - Enter project name: `aeromap` (or any name)
   - Create a secure password
   - Select your region (closest to you)
   - Click "Create new project" and wait for it to initialize

## Step 2: Get Your Supabase Credentials

1. Open your Supabase project dashboard
2. Click "Settings" → "API"
3. Copy these values:
   - **Project URL**: `https://xxxxx.supabase.co`
   - **Anon Public Key**: (copy the `anon` key)

## Step 3: Create Storage Bucket

1. In Supabase dashboard, go to "Storage"
2. Click "+ New bucket"
3. Name it: `shapefiles`
4. Check ☑️ "Public bucket" (so files are accessible)
5. Click "Create bucket"

## Step 4: Configure Environment Variables

On Vercel:

1. Go to your project on [vercel.com](https://vercel.com/dashboard)
2. Click "Settings" → "Environment Variables"
3. Add these variables (copy from Supabase):
   - **SUPABASE_URL**: `https://xxxxx.supabase.co`
   - **SUPABASE_ANON_KEY**: (your anon key from step 2)
   - **SUPABASE_BUCKET**: `shapefiles`

4. Click "Save"

## Step 5: Upload & Visualize Shapefiles

### Via Web UI
1. Open your deployed site: `https://aeromap-xxx.vercel.app`
2. Click the "Upload Shapefile" button
3. Select a `.zip` file containing your Shapefile (must include `.shp`, `.shx`, `.dbf`)
4. Wait for upload to complete
5. The map will automatically display your data

### Via API
```bash
# Upload a Shapefile
curl -X POST https://aeromap-xxx.vercel.app/api/upload \
  -F "file=@shapefile.zip"

# Get list of uploaded files
curl https://aeromap-xxx.vercel.app/api/files
```

## File Format Requirements

Shapefiles must be uploaded as a `.zip` containing:
- `yourfile.shp` (geometry)
- `yourfile.shx` (index)
- `yourfile.dbf` (attributes)
- Optional: `yourfile.prj` (projection info)

## Architecture

```
User Uploads File
    ↓
Vercel Serverless Function (/api/upload.js)
    ↓
Supabase File Storage (shapefiles bucket)
    ↓
Frontend Fetches File URL
    ↓
Parse with shp.js (browser)
    ↓
Display on Leaflet Map
```

## Free Tier Limits

- **Supabase Storage**: 5GB free
- **Bandwidth**: 2GB/month free
- **Fully sufficient for testing and personal use**

## Troubleshooting

**"Bucket not found" error:**
- Make sure bucket is created and set to public

**"Invalid credentials" error:**
- Double-check SUPABASE_URL and SUPABASE_ANON_KEY in Vercel settings
- Redeploy after updating environment variables

**Uploaded file not appearing:**
- Clear browser cache
- Check Supabase dashboard → Storage to verify file was saved
- Make sure bucket is public

## Next Steps

1. Complete Setup above
2. Redeploy on Vercel (push to GitHub triggers auto-deploy)
3. Test uploading a Shapefile
4. The file will be stored in Supabase and accessible on your map

For questions, check Supabase documentation: [supabase.com/docs](https://supabase.com/docs)
