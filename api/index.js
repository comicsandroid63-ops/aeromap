module.exports = (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // API Routes
  if (req.url.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    
    // Upload endpoint would require streaming/form parsing
    // For now, return a placeholder
    if (req.method === 'POST' && req.url === '/api/upload') {
      res.status(200).json({
        success: true,
        message: 'File upload would be processed here',
        note: 'Use local deployment for file uploads'
      });
      return;
    }

    // Files endpoint
    if (req.url === '/api/files') {
      res.status(200).json({
        success: true,
        files: []
      });
      return;
    }

    res.status(404).json({
      success: false,
      message: 'API endpoint not found'
    });
    return;
  }

  // Serve static files or main page
  res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').end(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>AeroMap - Loading</title>
      </head>
      <body>
        <script>
          // Redirect to the actual app
          window.location.href = '/';
        </script>
        <p>Redirecting to AeroMap...</p>
      </body>
    </html>
  `);
};
