const { onRequest } = require("firebase-functions/v2/https");
const Busboy = require("busboy");
require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Initialize Gemini API with key from environment variable
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);


// JSON Schema for structured output
const jsonSchema = {
  type: "object",
  properties: {
    name: { 
      type: "string",
      description: "Product name (max 2 words)"
    },
    ingredients: {
      type: "array",
      items: { type: "string" },
      description: "List of ingredients"
    },
    nutrition: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { 
            type: "string",
            description: "Nutrient name"
          },
          value: { 
            type: "number",
            description: "Numeric value exactly as shown on label"
          },
          unit: { 
            type: "string",
            description: "Unit of measurement (e.g., g, mg, kcal)"
          }
        },
        required: ["name", "value", "unit"]
      }
    },
    healthscore: {
      type: "object",
      properties: {
        Energy: { 
          type: "string",
          description: "Energy value with unit (e.g., '380 kcal')"
        },
        Sugars: { 
          type: "string",
          description: "Sugars value with unit (e.g., '22 g')"
        },
        Sodium: { 
          type: "string",
          description: "Sodium value with unit (e.g., '450 mg')"
        },
        Protein: { 
          type: "string",
          description: "Protein value with unit (e.g., '9.1 g')"
        },
        Fiber: { 
          type: "string",
          description: "Fiber value with unit (e.g., '2.5 g')"
        },
        FruitsVegetablesNuts: { 
          type: "string",
          description: "Percentage of fruits/vegetables/nuts (e.g., '0' or '40%')"
        },
        SaturatedFat: { 
          type: "string",
          description: "Saturated fat value with unit (e.g., '3.2 g')"
        }
      },
      required: ["Energy", "Sugars", "Sodium", "Protein", "Fiber", "FruitsVegetablesNuts", "SaturatedFat"]
    }
  },
  required: ["name", "ingredients", "nutrition", "healthscore"]
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
- **GENERALIZE ingredient names** - Remove marketing terms, percentages, quality descriptors, and processing methods:
  * "100% whole grain rolled oats" → "Oats" or "Rolled Oats"
  * "Organic unbleached wheat flour" → "Wheat Flour"
  * "Cold-pressed extra virgin olive oil" → "Olive Oil"
  * "Pea protein concentrate with tapioca starch" → "Pea Protein, Tapioca Starch" (separate if multiple ingredients)
  * "Whey protein crisps" → "Whey Protein"
  * "Natural cane sugar" → "Sugar"
  * "Sea salt" → "Salt"
- Remove values and percentages from ingredient names (e.g., "Wheat Flour (63%)" should become "Wheat Flour").
- Remove content inside brackets and parentheses EXCEPT for food additive codes (e.g., "MILK PRODUCTS [WHEY POWDER & MILK SOLIDS]" should become "Milk Products").
- **Retain food additive codes** like "Emulsifier (E322)" or "Raising Agent (INS 500(ii))" - these are important.
- Separate compound ingredients into their base components when clearly identifiable.
- Use standard, simple ingredient names without adjectives like "premium", "organic", "natural", "100%", "pure", "authentic", etc.
- Capitalize properly: First letter of each main word (e.g., "Wheat Flour", "Olive Oil", "Sea Salt").

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
          • "Saturated Fat" (instead of "Saturated Fatty Acids", "Sat Fat", etc.)
          • "Carbohydrates" (instead of "Carbohydrate", "Total Carbohydrates", "Carbs", "Carbohydrate" etc.), make sure this is always in plural like "Carbohydrates"
          • "Fiber" (instead of "Dietary Fiber", etc.)
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
          • "Thiamine" (instead of "Vitamin B1")
          • "Riboflavin" (instead of "Vitamin B2")
          • "Niacin" (instead of "Vitamin B3")
          • "Vitamin B6"
          • "Folate" (instead of "Vitamin B9", "Folic Acid")
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
- Correct common OCR errors (e.g., '0' misread as 'O', 'l' misread as '1').
- Use contextual understanding to extract accurate data even from messy text.
- Ensure data is structured properly, avoiding missing or misclassified information.

Output Format:
- Return the extracted data in a structured JSON format with three keys:
  • "name": a string
  • "ingredients": an array of ingredient strings.
  • "nutrition": an array of objects (each with "name", "value", and "unit").
  • "healthscore": an object containing keys "Energy", "Sugars", "Sodium", "Protein", "Fiber", "FruitsVegetablesNuts", and "SaturatedFat", where each value is a string including the unit.
- If any section is missing or unclear, return "ingredients": [] or "nutrition": [] or "healthscore": {}.

Final Requirement:
- Extract information as accurately as possible while handling formatting issues and OCR inconsistencies.
- If the image does not appear to be a valid food product label or if the contents do not contain recognizable ingredients or nutritional information, return a JSON object with an "error" field containing a simple error message (e.g., "Invalid product label") and empty values for "ingredients", "nutrition", and "healthscore".`;

/**
 * Analyzes a food label image using Gemini API directly
 * @param {Buffer} imageBuffer - Image buffer
 * @param {string} mimeType - Image MIME type
 * @returns {Promise<Object>} - Extracted product data
 */
async function analyzeLabel(imageBuffer, mimeType) {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash-exp",
      systemInstruction: {
        role: "system",
        parts: [{ text: systemInstruction }]
      },
      generationConfig: {
        temperature: 0.1,  // Lower temperature for more consistent output
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 16384,  // Increased token limit to handle larger responses
        responseMimeType: "application/json",
        responseSchema: jsonSchema
      }
    });

    // Prepare prompt and input
    const prompt = `Extract the ingredients, nutritional information, and healthscore from this food label image and analyse what could be the name of the product. 

IMPORTANT INSTRUCTIONS:
1. Extract exact numeric values from the label without rounding or modification.
2. GENERALIZE ingredient names - remove marketing terms, quality descriptors, percentages, and processing methods. Example: "100% whole grain rolled oats" should be extracted as just "Oats" or "Rolled Oats".`;

    // Convert buffer to base64
    const base64Image = imageBuffer.toString('base64');

    const result = await model.generateContent([
      {
        inlineData: {
          data: base64Image,
          mimeType: mimeType || "image/jpeg"
        }
      },
      { text: prompt }
    ]);

    console.log("========== GEMINI RAW RESPONSE ==========");
    const response = result.response;
    console.log("Full response object:", JSON.stringify(response, null, 2));
    
    const text = response.text();
    console.log("========== GEMINI TEXT OUTPUT ==========");
    console.log(text);
    console.log("========== END GEMINI OUTPUT ==========");

    // Parse JSON safely
    try {
      const parsedData = JSON.parse(text);
      console.log("✓ Successfully parsed JSON response");
      console.log("Parsed data keys:", Object.keys(parsedData));
      
      // Validate that we have some data
      if (!parsedData || typeof parsedData !== 'object') {
        console.error("✗ Invalid response format - not an object");
        return { error: "Invalid response format" };
      }
      
      console.log("✓ Returning parsed data to client");
      return parsedData;
    } catch (e) {
      console.error("✗ JSON Parse Error:", e.message);
      console.error("Raw text that failed to parse:", text);
      
      // Try to extract partial JSON if possible
      try {
        // Find the last complete JSON object before the error
        const lastBraceIndex = text.lastIndexOf('}');
        if (lastBraceIndex > 0) {
          const truncatedText = text.substring(0, lastBraceIndex + 1);
          console.log("Attempting to parse truncated JSON...");
          const partialData = JSON.parse(truncatedText);
          console.warn("⚠ Parsed truncated response due to token limit");
          return partialData;
        }
      } catch (partialError) {
        console.error("Could not parse truncated JSON either");
      }
      
      return { error: "Invalid or partial JSON response. Response may have been truncated due to size.", raw: text.substring(0, 500) + "..." };
    }
  } catch (error) {
    console.error("Error analyzing label:", error);
    throw error;
  }
}

/**
 * Firebase HTTPS Cloud Function
 * Endpoint: POST /analyzeLabelImage
 * Body: multipart/form-data with "image" file and optional "userId" field
 */
exports.analyzeLabelImage = onRequest(
  {
    timeoutSeconds: 300,
    memory: "1GiB",
    cors: true
  },
  async (req, res) => {
    console.log("========== NEW REQUEST ==========");
    console.log("Method:", req.method);
    console.log("Headers:", JSON.stringify(req.headers, null, 2));
    console.log("Raw URL:", req.url);
    console.log("Body type:", typeof req.body);
    console.log("Has rawBody:", !!req.rawBody);
    
    if (req.method !== "POST") {
      return res.status(405).json({
        success: false,
        error: "Method not allowed. Use POST."
      });
    }

    const contentType = req.headers['content-type'] || req.headers['Content-Type'] || '';
    console.log("Content-Type:", contentType);
    
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({
        success: false,
        error: "Content-Type must be multipart/form-data. Current: " + contentType
      });
    }

    // Manually collect the raw body data if not already available
    console.log("Collecting request body...");
    
    const getRawBody = () => {
      return new Promise((resolve, reject) => {
        if (req.rawBody) {
          console.log("Using existing rawBody");
          resolve(req.rawBody);
          return;
        }

        const chunks = [];
        let totalSize = 0;

        req.on('data', (chunk) => {
          totalSize += chunk.length;
          console.log(`Received chunk: ${chunk.length} bytes (total: ${totalSize})`);
          chunks.push(chunk);
        });

        req.on('end', () => {
          console.log(`Request end: Total ${totalSize} bytes received`);
          resolve(Buffer.concat(chunks));
        });

        req.on('error', (err) => {
          console.error("Request error:", err);
          reject(err);
        });

        // Trigger reading if needed
        if (req.readable) {
          req.resume();
        }
      });
    };

    let rawBodyBuffer;
    try {
      rawBodyBuffer = await getRawBody();
      console.log("Raw body collected, size:", rawBodyBuffer.length);
    } catch (error) {
      console.error("Error collecting raw body:", error);
      return res.status(500).json({
        success: false,
        error: "Failed to read request body: " + error.message
      });
    }

    if (!rawBodyBuffer || rawBodyBuffer.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Empty request body"
      });
    }

    // Parse multipart form data using busboy
    console.log("Creating Busboy instance...");
    
    let busboy;
    try {
      busboy = Busboy({ 
        headers: req.headers,
        limits: {
          fileSize: 10 * 1024 * 1024, // 10MB limit
          files: 1
        }
      });
      console.log("Busboy instance created successfully");
    } catch (error) {
      console.error("Error creating Busboy:", error);
      return res.status(500).json({
        success: false,
        error: "Failed to initialize file parser: " + error.message
      });
    }

    let fileBuffer = null;
    let fileMimeType = null;
    let fileName = null;
    let userId = null;
    const fields = {};
    let filesReceived = 0;
    let fieldsReceived = 0;

    // Handle file upload
    busboy.on('file', (fieldname, file, info) => {
      filesReceived++;
      const { filename, encoding, mimeType } = info;
      
      console.log(`[FILE EVENT] Field: ${fieldname}, Filename: ${filename}, Encoding: ${encoding}, MimeType: ${mimeType}`);

      if (fieldname !== 'image') {
        console.log(`Ignoring file field '${fieldname}' (expected 'image')`);
        file.resume(); // Drain the stream
        return;
      }

      if (!mimeType.startsWith('image/')) {
        console.log(`Rejecting non-image file: ${mimeType}`);
        file.resume();
        return;
      }

      const chunks = [];
      let bytesReceived = 0;
      
      file.on('data', (data) => {
        bytesReceived += data.length;
        console.log(`Receiving file data: ${data.length} bytes (total: ${bytesReceived})`);
        chunks.push(data);
      });

      file.on('end', () => {
        fileBuffer = Buffer.concat(chunks);
        fileMimeType = mimeType;
        fileName = filename;
        console.log(`[FILE END] Field: ${fieldname}, Total size: ${fileBuffer.length} bytes`);
      });

      file.on('limit', () => {
        console.error('[FILE LIMIT] File size limit reached (10MB max)');
      });

      file.on('error', (err) => {
        console.error('[FILE ERROR]', err);
      });
    });

    // Handle form fields
    busboy.on('field', (fieldname, value) => {
      fieldsReceived++;
      console.log(`[FIELD EVENT] ${fieldname} = ${value}`);
      fields[fieldname] = value;
      if (fieldname === 'userId') {
        userId = value;
      }
    });

    // Handle completion
    busboy.on('finish', async () => {
      console.log(`[BUSBOY FINISH] Files received: ${filesReceived}, Fields received: ${fieldsReceived}`);
      
      try {
        if (!fileBuffer) {
          console.error("No file buffer found after busboy finish");
          return res.status(400).json({
            success: false,
            error: `Image file is required. Received ${filesReceived} files and ${fieldsReceived} fields. Please upload an image using the 'image' field with multipart/form-data.`
          });
        }

        console.log("✓ Processing label analysis request", {
          userId: userId || "anonymous",
          fileName: fileName,
          fileSize: fileBuffer.length,
          mimeType: fileMimeType,
          timestamp: new Date().toISOString()
        });

        const analysisResult = await analyzeLabel(fileBuffer, fileMimeType);

        console.log("========== ANALYSIS RESULT ==========");
        console.log("Result received from analyzeLabel:");
        console.log(JSON.stringify(analysisResult, null, 2));
        console.log("=====================================");

        // Check if the result indicates an error from AI
        if (analysisResult.error) {
          console.log("✗ Analysis returned an error:", analysisResult.error);
          return res.status(400).json({
            success: false,
            error: analysisResult.error,
            data: null
          });
        }

        // Validate that we got meaningful data
        if (!analysisResult.ingredients || analysisResult.ingredients.length === 0) {
          if (!analysisResult.nutrition || analysisResult.nutrition.length === 0) {
            console.log("✗ No meaningful data extracted (empty ingredients and nutrition)");
            return res.status(400).json({
              success: false,
              error: "Could not detect any ingredients or nutritional information. Please try again with a clearer image.",
              data: null
            });
          }
        }

        console.log("✓ Analysis successful - sending response to client");
        console.log(`  - Ingredients: ${analysisResult.ingredients?.length || 0} items`);
        console.log(`  - Nutrition: ${analysisResult.nutrition?.length || 0} items`);
        console.log(`  - Product name: ${analysisResult.name || 'N/A'}`);
        
        return res.status(200).json({
          success: true,
          data: analysisResult,
          error: null
        });
      } catch (error) {
        console.error("[ERROR] Error analyzing image:", error);
        return res.status(500).json({
          success: false,
          error: error.message || "An error occurred while analyzing the image",
          data: null
        });
      }
    });

    // Handle busboy errors
    busboy.on('error', (error) => {
      console.error("[BUSBOY ERROR]", error.message);
      console.error("Stack:", error.stack);
      return res.status(400).json({
        success: false,
        error: "File upload error: " + error.message
      });
    });

    // Handle close event
    busboy.on('close', () => {
      console.log("[BUSBOY CLOSE] Stream closed");
    });

    // Create a readable stream from the collected raw body buffer
    console.log("Creating stream from raw body buffer...");
    const { Readable } = require('stream');
    const bufferStream = new Readable();
    bufferStream.push(rawBodyBuffer);
    bufferStream.push(null); // Signal end of stream
    
    try {
      bufferStream.pipe(busboy);
      console.log("Buffer stream piped successfully to busboy");
    } catch (error) {
      console.error("[PIPE ERROR]", error);
      return res.status(500).json({
        success: false,
        error: "Failed to process request: " + error.message
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
