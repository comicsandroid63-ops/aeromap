# Project Rules

## Uploads / Cloud Storage

- Heavy TIFFs that get optimized locally must **NOT** be uploaded to the cloud in their full/original version.
- Only the **optimized** version (`public/compressed/*_opt.tif`) may be uploaded to cloud storage (e.g. Supabase).
- After optimization, the original file in `public/uploads/` is **deleted**. Only the compressed version stays.
