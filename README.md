# What2Eat - Backend API

Backend API service for the What2Eat iOS app. Analyzes food label images using Google Gemini AI to extract ingredients, nutrition data, and calculate health scores.

## Overview

This Firebase Cloud Functions service is for internal use by the What2Eat iOS application. It provides AI-powered food label analysis and health score calculation based on the FSA Nutrient Profiling System.

## Features

- Extract product names, ingredients, and nutrition facts from food label images
- Calculate health scores (0-100) using FSA-NPS algorithm
- Support for both foods and beverages with different thresholds
- Automatic unit conversion and OCR error correction

## Tech Stack

- Node.js 22
- Firebase Cloud Functions v2
- Google Gemini 1.5 Flash
- `@google/generative-ai`, `firebase-functions`, `firebase-admin`, `dotenv`

## API Endpoints

### 1. Analyze Label Image

**POST** `/analyzeLabelImage`

Extract structured data from food label images.

**Request:**
```json
{
  "image": "base64_encoded_image_string",
  "userId": "optional_user_id"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "name": "Product Name",
    "ingredients": ["Ingredient 1", "Ingredient 2"],
    "nutrition": [
      { "name": "Energy", "value": 481, "unit": "kcal" },
      { "name": "Protein", "value": 9.1, "unit": "g" }
    ],
    "healthscore": {
      "Energy": "481 kcal",
      "Sugars": "22.5 g",
      "Sodium": "180 mg",
      "Protein": "9.1 g",
      "Fiber": "3.5 g",
      "FruitsVegetablesNuts": "0",
      "SaturatedFat": "5.2 g"
    }
  }
}
```

### 2. Calculate Health Score

**POST** `/calculateHealthScore`

Calculate health score from nutritional data.

**Request:**
```json
{
  "nutrition": {
    "energy": "481 kcal",
    "sugars": "22.5 g",
    "sodium": "180 mg",
    "protein": "9.1 g",
    "fiber": "3.5 g",
    "fruitsVegetablesNuts": "0",
    "saturatedFat": "5.2 g"
  },
  "isBeverage": false
}
```

**Response:**
```json
{
  "success": true,
  "healthScore": 42,
  "calculationDetails": {
    "negativePoints": 18,
    "positivePoints": 7,
    "fsaScore": 11
  }
}
```

### 3. Health Check

**GET** `/healthCheck`

Verify service status.

**Response:**
```json
{
  "status": "healthy",
  "service": "What2Eat Label Analysis API",
  "version": "1.0.0",
  "timestamp": "2025-10-25T12:00:00.000Z"
}
```


## Health Score Calculation

Based on FSA Nutrient Profiling System:
- **Negative points** (0-40): Energy, sugars, saturated fat, sodium
- **Positive points** (0-15): Fruits/vegetables/nuts, fiber, protein
- **Final score** (0-100): Higher = healthier

Different thresholds apply for foods (per 100g) vs beverages (per 100ml).

## Image Requirements

- Format: JPEG or PNG (base64 encoded)
- Quality: Clear, well-lit images
- Content: Visible ingredients and/or nutrition facts
- Size: Under 5MB recommended

## License

MIT License - See [LICENSE](LICENSE) file for details.

## Support

For internal support, contact the What2Eat development team.

---

**What2Eat Backend API** - Powering intelligent food choices
