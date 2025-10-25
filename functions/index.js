const { onRequest } = require("firebase-functions/v2/https");
require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Initialize Gemini API with key from environment variable
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);


// JSON Schema for structured output
const jsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    ingredients: {
      type: "array",
      items: { type: "string" }
    },
    nutrition: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          value: { type: "number" },
          unit: { type: "string" }
        }
      }
    },
    healthscore: {
      type: "object",
      properties: {
        Energy: { type: "string" },
        Sugars: { type: "string" },
        Sodium: { type: "string" },
        Protein: { type: "string" },
        Fiber: { type: "string" },
        FruitsVegetablesNuts: { type: "string" },
        SaturatedFat: { type: "string" }
      }
    }
  }
};

// ==================== HEALTH SCORE CALCULATION FUNCTIONS ====================

// Unit conversion handler with field name flexibility
function parseNutritionValue(rawValue, nutrientType) {
  if (!rawValue) return 0;
  
  const strValue = rawValue.toString().trim();
  const matches = strValue.match(/([0-9.]+)([a-zA-Z%]*)/);
  if (!matches) return 0;

  const value = parseFloat(matches[1]);
  const unit = matches[2].toLowerCase();

  switch (nutrientType) {
    case 'energy':
      return unit === 'kj' ? value / 4.184 : value; // kJ to kcal

    case 'sodium':
      return unit === 'g' ? value * 1000 : value; // g to mg

    case 'mass':
      if (unit === 'mg') return value / 1000; // mg to g
      if (unit === 'mcg') return value / 1_000_000; // mcg to g
      return value;

    case 'percentage':
      return unit === '%' ? value : 0;

    default:
      return value;
  }
}

// Negative Points Calculation
function calculateNegativePoints(nutrition, isBeverage = 0) {
  // Handle field name variations
  const energy = parseNutritionValue(nutrition.energy || '0', 'energy');
  const sugarsValue = nutrition.TotalSugars || nutrition.sugars || '0';
  const sugars = parseNutritionValue(sugarsValue, 'mass');
  const saturatedFat = parseNutritionValue(nutrition.saturatedFat || '0', 'mass');
  const sodium = parseNutritionValue(nutrition.sodium || '0', 'sodium');

  let energyThresholds, sugarsThresholds, satFatThresholds, sodiumThresholds;

  if (isBeverage) {
    // Beverage thresholds (per 100ml)
    energyThresholds = [7.2, 14.3, 21.5, 28.5, 35.9, 43.0, 50.2, 57.4, 64.5];
    sugarsThresholds = [0, 1.5, 3.0, 4.5, 6.0, 7.5, 9.0, 10.5, 12.0, 13.5];
    satFatThresholds = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    sodiumThresholds = [0, 45, 90, 135, 180, 225, 270, 315, 360, 405];
  } else {
    // Food thresholds (per 100g)
    energyThresholds = [80, 160, 240, 320, 400, 480, 560, 640, 720, 800];
    sugarsThresholds = [4.5, 9.0, 13.5, 18.0, 22.5, 27.0, 31.0, 36.0, 40.0, 45.0];
    satFatThresholds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    sodiumThresholds = [90, 180, 270, 360, 450, 540, 630, 720, 810, 900];
  }

  const energyPoints = energyThresholds.filter(t => energy > t).length;
  const sugarsPoints = sugarsThresholds.filter(t => sugars > t).length;
  const satFatPoints = satFatThresholds.filter(t => saturatedFat > t).length;
  const sodiumPoints = sodiumThresholds.filter(t => sodium > t).length;

  return energyPoints + sugarsPoints + satFatPoints + sodiumPoints;
}

// Positive Points Calculation
function calculatePositivePoints(nutrition, isBeverage = 0) {
  // Handle field name variations
  const fiberValue = nutrition.dietaryfiber || nutrition.fiber || '0';
  const fvln = parseNutritionValue(nutrition.fruitsVegetablesNuts || '0', 'percentage');
  const fiber = parseNutritionValue(fiberValue, 'mass');
  const protein = parseNutritionValue(nutrition.protein || '0', 'mass');

  // FVNL points (fruits, vegetables, nuts, legumes)
  let fvlnPoints = 0;
  if (fvln >= 80) fvlnPoints = 5;
  else if (fvln >= 60) fvlnPoints = 2;
  else if (fvln >= 40) fvlnPoints = 1;

  // Fiber thresholds (g/100g for both foods and beverages)
  const fiberThresholds = [0.7, 1.4, 2.1, 2.8, 3.5];
  const fiberPoints = fiberThresholds.filter(t => fiber > t).length;

  // Protein thresholds (g/100g for both foods and beverages)
  const proteinThresholds = [1.6, 3.2, 4.8, 6.4, 8.0];
  const proteinPoints = proteinThresholds.filter(t => protein > t).length;

  return {
    fvln: fvlnPoints,
    fiber: fiberPoints,
    protein: proteinPoints,
    total: fvlnPoints + fiberPoints + proteinPoints
  };
}

// Main calculation function
function calculateHealthScoreLogic(nutrition, isBeverage = 0) {
  const N = calculateNegativePoints(nutrition, isBeverage);
  const P = calculatePositivePoints(nutrition, isBeverage);

  // Calculate FSA-score
  let fsaScore;
  if (N < 11) {
    fsaScore = N - P.total;
  } else {
    fsaScore = P.fvln === 5 
      ? N - P.total 
      : N - (P.fvln + P.fiber);
  }

  // Normalize to 0-100 scale (higher = healthier)
  const minScore = -15;
  const maxScore = 40;
  const normalized = ((fsaScore - minScore) / (maxScore - minScore)) * 100;
  const healthScore = Math.round(100 - Math.min(100, Math.max(0, normalized)));

  return {
    healthScore,
    calculationDetails: {
      negativePoints: N,
      positivePoints: P.total,
      fsaScore
    }
  };
}

// ==================== END HEALTH SCORE CALCULATION ====================

// System instruction for Gemini
const systemInstruction = `You are an advanced AI assistant specialized in extracting structured data from images of food packaging. Your task is to extract key details from the image, including ingredients, nutritional information, and a healthscore.

Instructions:
Name Extraction:
- Analyse the Name of the product from the Given image
- If cant find, analyse what could the name be.
- The Name should be short and simple and should not contain more than 2 words.
- It should represent the product

Ingredients Extraction:
- Identify the section labeled "Ingredients" or similar.
- Extract the full list of ingredients while preserving their order.
- Remove values and percentages from ingredient names (e.g., "Wheat Flour (63%)" should become "Wheat Flour").
- Remove content inside brackets (e.g., "MILK PRODUCTS [WHEY POWDER & MILK SOLIDS]" should become "MILK PRODUCTS").
- Retain food additive codes like "Emulsifier (E322)" or "Raising Agent (INS 500(ii))".
- Ignore unnecessary words or unrelated text.

Nutritional Information Extraction:
        - Identify the section labeled "Nutrition Information" or "Nutritional Facts".
        - Extract key nutrient names, values, and units (e.g., "Protein: 9.1 g").
        - Only extract values per 100g of the product.
        - If multiple columns exist (**e.g., "Per Serving" and "Per 100g"**), always choose the **Per 100g** values.
        - If only "Per Serving" is provided but serving size is mentioned, **convert values proportionally to 100g**.
        - Standardize nutrient names to match the following expected format (case-insensitive):
          • "Energy" (instead of "Calories", "kcal", etc.)
          • "Protein"
          • "Total Fat" (instead of "Fat", "Total Fats", etc.)
          • "Saturated Fat"
          • "Carbohydrates"
          • "Fiber"
          • "Sugars"
          • "Calcium"
          • "Magnesium"
          • "Iron"
          • "Zinc"
          • "Iodine"
          • "Sodium"
          • "Potassium"
          • "Phosphorus"
          • "Copper"
          • "Selenium"
          • "Vitamin A"
          • "Vitamin C"
          • "Vitamin D"
          • "Vitamin E"
          • "Thiamine"
          • "Riboflavin"
          • "Niacin"
          • "Vitamin B6"
          • "Folate"
          • "Vitamin B12"
        - If a nutrient name does not match the above list, include it as-is.
        
Healthscore Extraction:
- From the nutritional data, extract only the following:
  • Energy
  • Sugars
  • Sodium
  • Protein
  • Fiber
  • FruitsVegetablesNuts (as a percentage)
  • SaturatedFat
- Output these values as strings including their units (e.g., "481 kcal", "9.1 g").
- If any value is missing, set it to "0".

Handling OCR Noise & Inconsistencies:
- Correct common OCR errors.
- Use contextual understanding to extract accurate data even from messy text.
- Ensure data is structured properly, avoiding missing or misclassified information.

Output Format:
- Return the extracted data in a structured JSON format with three keys:
  • "name"
  • "ingredients"
  • "nutrition"
  • "healthscore"
- If invalid image or unrecognized label, return { "error": "Invalid product label" }.`;

/**
 * Analyzes a food label image using Gemini API directly
 * @param {string} base64Image - Base64 encoded image string
 * @returns {Promise<Object>} - Extracted product data
 */
async function analyzeLabel(base64Image) {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: jsonSchema
      }
    });

    // Prepare prompt and input
    const prompt = `Extract the ingredients, nutritional information, and healthscore from this food label image and analyze what could be the name of the product. 
    Follow the JSON schema and the system instructions strictly.`;

    const result = await model.generateContent([
      { text: systemInstruction },
      {
        inlineData: {
          data: base64Image,
          mimeType: "image/jpeg"
        }
      },
      { text: prompt }
    ]);

    const response = result.response;
    const text = response.text();

    // Parse JSON safely
    try {
      const parsedData = JSON.parse(text);
      
      // Validate that we have some data
      if (!parsedData || typeof parsedData !== 'object') {
        return { error: "Invalid response format" };
      }
      
      return parsedData;
    } catch (e) {
      console.warn("Non-JSON output received:", e.message);
      return { error: "Invalid or partial JSON response", raw: text };
    }
  } catch (error) {
    console.error("Error analyzing label:", error);
    throw error;
  }
}

/**
 * Firebase HTTPS Cloud Function
 * Endpoint: POST /analyzeLabelImage
 * Body: { "image": "base64_string", "userId": "optional_user_id" }
 */
exports.analyzeLabelImage = onRequest(
  {
    timeoutSeconds: 300,
    memory: "1GiB",
    cors: true
  },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        return res.status(405).json({
          success: false,
          error: "Method not allowed. Use POST."
        });
      }

      const { image, userId } = req.body;

      if (!image) {
        return res.status(400).json({
          success: false,
          error: "Image data is required"
        });
      }

      // Validate image is a string
      if (typeof image !== 'string') {
        return res.status(400).json({
          success: false,
          error: "Image must be a base64 string"
        });
      }

      // Remove data:image prefix if present
      const base64Image = image.includes(",") ? image.split(",")[1] : image;

      console.log("Processing label analysis request", {
        userId: userId || "anonymous",
        imageSize: base64Image.length,
        timestamp: new Date().toISOString()
      });

      const analysisResult = await analyzeLabel(base64Image);

      if (analysisResult.error) {
        return res.status(400).json({
          success: false,
          error: analysisResult.error,
          data: null
        });
      }

      if (
        (!analysisResult.ingredients || analysisResult.ingredients.length === 0) &&
        (!analysisResult.nutrition || analysisResult.nutrition.length === 0)
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Could not detect any ingredients or nutritional information. Please try again with a clearer image.",
          data: null
        });
      }

      return res.status(200).json({
        success: true,
        data: analysisResult,
        error: null
      });
    } catch (error) {
      console.error("Error in analyzeLabelImage function:", error);
      return res.status(500).json({
        success: false,
        error: error.message || "An error occurred while analyzing the image",
        data: null
      });
    }
  });

/**
 * Health check endpoint
 */
exports.healthCheck = onRequest({ cors: true }, (req, res) => {
  res.status(200).json({
    status: "healthy",
    service: "What2Eat Label Analysis API",
    version: "1.0.0",
    timestamp: new Date().toISOString()
  });
});

/**
 * Calculate Health Score endpoint
 * Endpoint: POST /calculateHealthScore
 * Body: { "nutrition": {...}, "isBeverage": boolean }
 */
exports.calculateHealthScore = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== 'POST') {
      return res.status(400).json({ 
        success: false,
        error: 'POST request required' 
      });
    }
    
    const { nutrition, isBeverage } = req.body;
    
    if (!nutrition) {
      return res.status(400).json({ 
        success: false,
        error: 'Nutrition data required' 
      });
    }

    const isBeverageFlag = isBeverage ? 1 : 0;
    const result = calculateHealthScoreLogic(nutrition, isBeverageFlag);
    
    return res.status(200).json({
      success: true,
      ...result
    });
    
  } catch (error) {
    console.error('Error in calculateHealthScore:', error);
    return res.status(500).json({ 
      success: false,
      error: error.message || 'An error occurred while calculating health score'
    });
  }
});
