const express = require("express");
const path = require("path");
const fs = require("fs");
const logger = require("../config/logger");

// Helper function to generate Swagger UI HTML
const generateSwaggerHTML = (title, specUrl, subtitle) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@3/swagger-ui.css">
    <style>
        html {
            box-sizing: border-box;
            overflow: -moz-scrollbars-vertical;
            overflow-y: scroll;
        }
        *, *:before, *:after {
            box-sizing: inherit;
        }
        body {
            margin: 0;
            padding: 0;
            background: #fafafa;
            font-family: sans-serif;
        }
        .topbar {
            background-color: #1d1a1a;
            padding: 10px 0;
            border-bottom: 1px solid #666;
        }
        .topbar-title {
            color: #fff;
            font-size: 20px;
            font-weight: bold;
            margin: 0 30px;
        }
        .topbar-subtitle {
            color: #aaa;
            font-size: 13px;
            margin: 5px 30px 0;
        }
        .docs-nav {
            background-color: #f5f5f5;
            padding: 10px 30px;
            border-bottom: 1px solid #ddd;
        }
        .docs-nav a {
            margin-right: 20px;
            text-decoration: none;
            color: #555;
            font-size: 14px;
        }
        .docs-nav a.active {
            color: #1d1a1a;
            font-weight: bold;
            border-bottom: 2px solid #1d1a1a;
            padding-bottom: 5px;
        }
    </style>
</head>
<body>
    <div class="topbar">
        <div class="topbar-title">${title}</div>
        <div class="topbar-subtitle">${subtitle}</div>
    </div>
    <div class="docs-nav">
        <a href="/docs">📱 Marketer Portal API</a>
        <a href="/docs/school-system">🏫 School System API</a>
    </div>

    <div id="swagger-ui"></div>

    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@3/swagger-ui-bundle.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@3/swagger-ui-standalone-preset.js"></script>
    <script>
        window.onload = function() {
            const ui = SwaggerUIBundle({
                url: "${specUrl}",
                dom_id: '#swagger-ui',
                presets: [
                    SwaggerUIBundle.presets.apis,
                    SwaggerUIStandalonePreset
                ],
                layout: "BaseLayout",
                deepLinking: true,
                defaultModelsExpandDepth: 1,
                docExpansion: "list",
                filter: true,
                showRequestHeaders: true,
                supportedSubmitMethods: [
                    'get',
                    'post',
                    'put',
                    'patch',
                    'delete'
                ],
                requestInterceptor: function(request) {
                    request.headers['x-service-key'] = 'your-service-key-here';
                    return request;
                }
            });
            window.ui = ui;
        };
    </script>
</body>
</html>
`;

// Middleware to serve Swagger UI documentation
const documentationMiddleware = (app) => {
  const docsEnabled = process.env.ENABLE_DOCS === "true";

  if (!docsEnabled) {
    logger.debug("Documentation disabled (set ENABLE_DOCS=true to enable)");
    return;
  }

  try {
    // 1. MARKETER PORTAL API (/docs)
    const marketerPortalPath = path.join(__dirname, "../../docs/openapi.yaml");
    if (fs.existsSync(marketerPortalPath)) {
      app.get("/docs", (req, res) => {
        logger.info("[DOCS] Marketer Portal Swagger UI accessed");
        res.setHeader("Content-Type", "text/html");
        res.send(generateSwaggerHTML(
          "🚀 Qalox Marketer Portal API - Swagger UI",
          "/api/docs/openapi.yaml",
          "Complete REST API Documentation | v1.0.0"
        ));
      });

      app.get("/api/docs/openapi.yaml", (req, res) => {
        logger.debug("[DOCS] Marketer Portal OpenAPI spec requested");
        res.setHeader("Content-Type", "application/yaml");
        res.sendFile(marketerPortalPath);
      });
    } else {
      logger.warn("Marketer Portal OpenAPI spec not found");
    }

    // 2. SCHOOL SYSTEM API (/docs/school-system)
    const schoolSystemPath = path.join(__dirname, "../../docs/openapi-school-system.yaml");
    if (fs.existsSync(schoolSystemPath)) {
      app.get("/docs/school-system", (req, res) => {
        logger.info("[DOCS] School System Swagger UI accessed");
        res.setHeader("Content-Type", "text/html");
        res.send(generateSwaggerHTML(
          "🏫 Qalox School System API - Swagger UI",
          "/api/docs/openapi-school-system.yaml",
          "Complete School Management API Documentation | v1.0.0"
        ));
      });

      app.get("/api/docs/openapi-school-system.yaml", (req, res) => {
        logger.debug("[DOCS] School System OpenAPI spec requested");
        res.setHeader("Content-Type", "application/yaml");
        res.sendFile(schoolSystemPath);
      });
    } else {
      logger.warn("School System OpenAPI spec not found at", { path: schoolSystemPath });
    }

    // 3. SUPER ADMIN PORTAL API (/docs/super-admin)
    const superAdminPath = path.join(__dirname, "../../docs/openapi-super-admin.yaml");
    if (fs.existsSync(superAdminPath)) {
      app.get("/docs/super-admin", (req, res) => {
        logger.info("[DOCS] Super Admin Portal Swagger UI accessed");
        res.setHeader("Content-Type", "text/html");
        res.send(generateSwaggerHTML(
          "👑 Qalox Super Admin Portal API - Swagger UI",
          "/api/docs/openapi-super-admin.yaml",
          "Super Admin Management API Documentation | v1.0.0"
        ));
      });

      app.get("/api/docs/openapi-super-admin.yaml", (req, res) => {
        logger.debug("[DOCS] Super Admin OpenAPI spec requested");
        res.setHeader("Content-Type", "application/yaml");
        res.sendFile(superAdminPath);
      });
    } else {
      logger.warn("Super Admin OpenAPI spec not found at", { path: superAdminPath });
    }

    // 4. DOCUMENTATION INDEX
    app.get("/api/docs", (req, res) => {
      logger.debug("[DOCS] Documentation index requested");
      res.json({
        success: true,
        message: "Qalox API Documentation",
        documentation: [
          {
            name: "Marketer Portal API",
            url: "/docs",
            description: "Complete REST API for Marketer Portal (authentication, wallet, commissions, dashboard)",
            version: "v1.0.0",
            baseUrl: "http://localhost:3000/api/public",
          },
          {
            name: "School System API",
            url: "/docs/school-system",
            description: "Complete REST API for School Management System (admin, schools, students, teachers, grading, results)",
            version: "v1.0.0",
            baseUrl: "http://localhost:3000/api/admin",
          },
          {
            name: "Super Admin Portal API",
            url: "/docs/super-admin",
            description: "Complete REST API for Super Admin Portal (authentication, admin management, token generation, settings)",
            version: "v1.0.0",
            baseUrl: "http://localhost:3000/api/super-admin",
          },
        ],
      });
    });

    // 4. SERVE REFERENCE DOCUMENTATION (if exists)
    app.get("/api/docs/reference", (req, res) => {
      logger.debug("[DOCS] Endpoint reference requested");
      const refPath = path.join(__dirname, "../../docs/ENDPOINT_REFERENCE.md");
      if (fs.existsSync(refPath)) {
        res.setHeader("Content-Type", "text/markdown");
        res.sendFile(refPath);
      } else {
        res.status(404).json({
          success: false,
          message: "Endpoint reference not found",
        });
      }
    });

    logger.info("✅ Documentation endpoints enabled");
    logger.info("   📱 Marketer Portal API: /docs");
    logger.info("   🏫 School System API: /docs/school-system");
    logger.info("   👑 Super Admin Portal API: /docs/super-admin");
    logger.info("   📋 Documentation Index: /api/docs");
  } catch (err) {
    logger.error("Failed to initialize documentation middleware", { error: err.message });
  }
};

module.exports = documentationMiddleware;
