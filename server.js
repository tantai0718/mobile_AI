require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const mysql = require('mysql2');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Load API Keys từ .env
const WIT_AI_ACCESS_TOKEN = process.env.WIT_AI_ACCESS_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Kiểm tra API Key
if (!GEMINI_API_KEY) {
    console.error('❌ LỖI: Chưa có GEMINI_API_KEY trong .env!');
    process.exit(1);
}
if (!WIT_AI_ACCESS_TOKEN) {
    console.error('❌ LỖI: Chưa có WIT_AI_ACCESS_TOKEN trong .env!');
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Kết nối MySQL
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

db.connect(err => {
    if (err) {
        console.error('❌ Lỗi kết nối MySQL:', err);
        process.exit(1);
    }
    console.log('✅ Kết nối MySQL thành công!');
});

// Cấu hình multer để upload file
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = path.join(__dirname, 'public', 'images');
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, file.fieldname + '-' + uniqueSuffix + ext);
    }
});

const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png/;
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = filetypes.test(file.mimetype);
        if (extname && mimetype) {
            return cb(null, true);
        } else {
            cb(new Error('Chỉ chấp nhận file ảnh (jpeg, jpg, png)!'));
        }
    },
    limits: { fileSize: 5 * 1024 * 1024 } // Giới hạn kích thước file: 5MB
});

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));
app.use('/admin', express.static('admin'));
app.use('/images', express.static('public/images'));

// Route cho trang chính (chatbot)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Route cho trang quản trị
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// Hàm định dạng giá theo chuẩn Việt Nam
function formatPrice(price) {
    return price.toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' VNĐ';
}

// Hàm truy vấn SQL với Promise
const query = (sql, params) => {
    return new Promise((resolve, reject) => {
        console.log('📋 Truy vấn SQL:', sql);
        console.log('📋 Tham số:', params);
        db.query(sql, params, (err, results) => {
            if (err) {
                console.error('❌ Lỗi truy vấn MySQL:', err);
                reject(err);
            } else {
                resolve(results);
            }
        });
    });
};

// API lấy danh sách sản phẩm từ MySQL (thêm phân trang, tìm kiếm, lọc)
app.get('/products', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const minPrice = parseFloat(req.query.minPrice) || 0;
    let maxPrice = parseFloat(req.query.maxPrice) || Infinity;
    const brand = req.query.brand || '';

    if (maxPrice === Infinity || isNaN(maxPrice)) {
        maxPrice = 999999999;
    }
    if (isNaN(minPrice)) {
        minPrice = 0;
    }

    let whereConditions = [
        `(LOWER(p.name) LIKE LOWER(?) OR LOWER(p.brand) LIKE LOWER(?))`,
        `p.price BETWEEN ? AND ?`
    ];
    let params = [`%${search}%`, `%${search}%`, minPrice, maxPrice];

    if (brand) {
        whereConditions.push(`p.brand = ?`);
        params.push(brand);
    }

    const whereClause = whereConditions.join(' AND ');

    try {
        const products = await query(
            `SELECT p.*, 
                    (SELECT GROUP_CONCAT(promotion_name SEPARATOR '; ') 
                     FROM promotions 
                     WHERE product_id = p.product_id OR product_id IS NULL) AS promotion_names,
                    (SELECT GROUP_CONCAT(feature_name SEPARATOR '; ') 
                     FROM features 
                     WHERE product_id = p.product_id) AS features
             FROM products p 
             WHERE ${whereClause}
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        const formattedProducts = products.map(product => ({
            ...product,
            formattedPrice: formatPrice(product.price)
        }));

        const totalResult = await query(
            `SELECT COUNT(*) as total 
             FROM products p 
             WHERE ${whereClause}`,
            [...params]
        );

        const total = totalResult && totalResult.length > 0 ? totalResult[0].total : 0;

        res.json({ products: formattedProducts, total, page, limit });
    } catch (err) {
        res.status(500).json({ error: 'Lỗi truy vấn dữ liệu.', details: err.message });
    }
});

// API thêm sản phẩm (có upload hình ảnh)
app.post('/admin/products', upload.single('image'), async (req, res) => {
    const { name, brand, description, price, colors, storage, release_date, warranty_period } = req.body;
    const image_url = req.file ? req.file.filename : null;

    if (!name || !brand || !price) {
        return res.status(400).json({ error: 'Tên, thương hiệu và giá là bắt buộc.' });
    }

    try {
        await query(
            `INSERT INTO products (name, brand, description, price, colors, storage, release_date, warranty_period, image_url) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, brand, description, price, colors, storage, release_date, warranty_period, image_url]
        );
        res.json({ message: 'Thêm sản phẩm thành công!' });
    } catch (err) {
        res.status(500).json({ error: 'Lỗi khi thêm sản phẩm.', details: err.message });
    }
});

// API sửa sản phẩm (có upload hình ảnh)
app.put('/admin/products/:id', upload.single('image'), async (req, res) => {
    const productId = req.params.id;
    const { name, brand, description, price, colors, storage, release_date, warranty_period } = req.body;
    const image_url = req.file ? req.file.filename : req.body.image_url;

    if (!name || !brand || !price) {
        return res.status(400).json({ error: 'Tên, thương hiệu và giá là bắt buộc.' });
    }

    try {
        if (req.file) {
            const oldProduct = await query(
                `SELECT image_url FROM products WHERE product_id = ?`,
                [productId]
            );
            if (oldProduct[0]?.image_url) {
                const oldImagePath = path.join(__dirname, 'public', 'images', oldProduct[0].image_url);
                if (fs.existsSync(oldImagePath)) {
                    fs.unlinkSync(oldImagePath);
                }
            }
        }

        const result = await query(
            `UPDATE products 
             SET name = ?, brand = ?, description = ?, price = ?, colors = ?, storage = ?, release_date = ?, warranty_period = ?, image_url = ? 
             WHERE product_id = ?`,
            [name, brand, description, price, colors, storage, release_date, warranty_period, image_url, productId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Sản phẩm không tồn tại.' });
        }

        res.json({ message: 'Cập nhật sản phẩm thành công!' });
    } catch (err) {
        res.status(500).json({ error: 'Lỗi khi cập nhật sản phẩm.', details: err.message });
    }
});

// API xóa sản phẩm
app.delete('/admin/products/:id', async (req, res) => {
    const productId = req.params.id;

    try {
        const product = await query(
            `SELECT image_url FROM products WHERE product_id = ?`,
            [productId]
        );
        if (product[0]?.image_url) {
            const imagePath = path.join(__dirname, 'public', 'images', product[0].image_url);
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
            }
        }

        const result = await query(
            `DELETE FROM products WHERE product_id = ?`,
            [productId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Sản phẩm không tồn tại.' });
        }

        res.json({ message: 'Xóa sản phẩm thành công!' });
    } catch (err) {
        res.status(500).json({ error: 'Lỗi khi xóa sản phẩm.', details: err.message });
    }
});

// Hàm gọi API Wit.ai
async function getWitResponse(message) {
    try {
        const response = await axios.get(
            `https://api.wit.ai/message?v=20220201&q=${encodeURIComponent(message)}`,
            {
                headers: { Authorization: `Bearer ${WIT_AI_ACCESS_TOKEN}` }
            }
        );
        return response.data;
    } catch (error) {
        console.error('❌ Lỗi từ Wit.ai:', error.response?.data || error.message);
        return null;
    }
}

// Hàm gọi Gemini AI
async function getGeminiResponse(prompt) {
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const result = await model.generateContent(prompt);
        return result.response.text();
    } catch (error) {
        console.error('❌ Lỗi từ Gemini AI:', error.response?.data || error.message);
        return 'Xin lỗi, tôi không thể trả lời ngay bây giờ. Bạn có thể hỏi lại hoặc cung cấp thêm thông tin không?';
    }
}

// Hàm lấy thông tin sản phẩm từ MySQL
async function getProductInfo(productName) {
    try {
        const results = await query(
            `SELECT p.*, 
                    (SELECT GROUP_CONCAT(promotion_name SEPARATOR '; ') 
                     FROM promotions 
                     WHERE product_id = p.product_id OR product_id IS NULL) AS promotion_names,
                    (SELECT GROUP_CONCAT(feature_name SEPARATOR '; ') 
                     FROM features 
                     WHERE product_id = p.product_id) AS features
             FROM products p 
             WHERE LOWER(p.name) LIKE LOWER(?)`,
            [`%${productName}%`]
        );
        return results[0] || null;
    } catch (err) {
        console.error('❌ Lỗi lấy thông tin sản phẩm:', err);
        return null;
    }
}

// Hàm tìm sản phẩm theo khoảng giá
async function findProductsByPriceRange(minPrice, maxPrice, productName = null) {
    try {
        let sql = `
            SELECT p.*,
                   (SELECT GROUP_CONCAT(promotion_name SEPARATOR '; ')
                     FROM promotions
                     WHERE product_id = p.product_id OR product_id IS NULL) AS promotion_names,
                   (SELECT GROUP_CONCAT(feature_name SEPARATOR '; ')
                     FROM features
                     WHERE product_id = p.product_id) AS features
            FROM products p
            WHERE p.price BETWEEN ? AND ?
        `;
        const params = [minPrice, maxPrice];

        if (productName) {
            sql += ` AND LOWER(p.name) LIKE LOWER(?)`;
            params.push(`%${productName}%`);
        }

        return await query(sql, params);
    } catch (err) {
        console.error('❌ Lỗi tìm sản phẩm theo giá:', err);
        throw err;
    }
}

// Hàm tìm sản phẩm theo thương hiệu
async function findProductsByBrand(brand, feature = null, color = null) {
    try {
        let sql = `SELECT p.*, 
                          (SELECT GROUP_CONCAT(promotion_name SEPARATOR '; ') 
                           FROM promotions 
                           WHERE product_id = p.product_id OR product_id IS NULL) AS promotion_names,
                          (SELECT GROUP_CONCAT(feature_name SEPARATOR '; ') 
                           FROM features 
                           WHERE product_id = p.product_id) AS features
                   FROM products p 
                   WHERE p.brand = ?`;
        let params = [brand];

        if (feature) {
            sql += ` AND EXISTS (
                        SELECT 1 
                        FROM features f 
                        WHERE f.product_id = p.product_id 
                        AND LOWER(f.feature_name) LIKE LOWER(?)
                    )`;
            params.push(`%${feature}%`);
        }

        if (color) {
            sql += ` AND LOWER(p.colors) LIKE LOWER(?)`;
            params.push(`%${color}%`);
        }

        return await query(sql, params);
    } catch (err) {
        console.error('❌ Lỗi tìm sản phẩm theo thương hiệu:', err);
        return [];
    }
}

// Hàm so sánh hai sản phẩm
async function compareProducts(productName1, productName2) {
    try {
        const product1 = await getProductInfo(productName1);
        const product2 = await getProductInfo(productName2);

        if (!product1 || !product2) {
            return null;
        }

        return { product1, product2 };
    } catch (err) {
        console.error('❌ Lỗi so sánh sản phẩm:', err);
        return null;
    }
}

// Hàm tìm thương hiệu trong câu hỏi nếu Wit.ai không nhận diện được
function extractBrandFromMessage(message) {
    const brands = ['vivo', 'oppo', 'samsung', 'apple', 'xiaomi', 'iphone'];
    const messageLower = message.toLowerCase();
    for (const brand of brands) {
        if (messageLower.includes(brand)) {
            return brand.charAt(0).toUpperCase() + brand.slice(1);
        }
    }
    return null;
}

// Hàm gợi ý sản phẩm tương tự
async function suggestSimilarProducts(brand, excludeProductName) {
    try {
        const products = await query(
            `SELECT p.*,
                    (SELECT GROUP_CONCAT(promotion_name SEPARATOR '; ') 
                     FROM promotions 
                     WHERE product_id = p.product_id OR product_id IS NULL) AS promotion_names,
                    (SELECT GROUP_CONCAT(feature_name SEPARATOR '; ') 
                     FROM features 
                     WHERE product_id = p.product_id) AS features
             FROM products p 
             WHERE p.brand = ? AND LOWER(p.name) NOT LIKE LOWER(?)
             LIMIT 3`,
            [brand, `%${excludeProductName}%`]
        );
        return products;
    } catch (err) {
        console.error('❌ Lỗi gợi ý sản phẩm tương tự:', err);
        return [];
    }
}

// Đối tượng để lưu trữ ngữ cảnh cho mỗi phiên
const conversationContext = {};

// Middleware để tạo hoặc lấy ngữ cảnh cho mỗi phiên
app.use((req, res, next) => {
    const sessionId = req.headers['session-id'] || req.query.sessionId || req.body.sessionId;

    if (!sessionId) {
        return res.status(400).json({ error: 'Session ID is required' });
    }

    if (!conversationContext[sessionId]) {
        conversationContext[sessionId] = {
            lastProduct: null,
            lastBrand: null,
            lastIntent: null,
            pendingOrder: null,
            history: [],
            consultation: { purpose: null, budget: null, feature: null, color: null },
            awaitingProductChoice: false
        };
    }
    req.context = conversationContext[sessionId];
    req.sessionId = sessionId;
    next();
});

// API xử lý chatbot
app.post('/chatbot', async (req, res) => {
    const userMessage = req.body.message.toLowerCase();
    const sessionId = req.sessionId;
    const context = req.context;

    console.log(`📩 User: ${userMessage} (Session: ${sessionId})`);

    // Reset awaitingProductChoice nếu đây là câu hỏi mới không liên quan đến thương hiệu trước
    if (!context.awaitingProductChoice || !userMessage.includes(context.lastBrand?.toLowerCase())) {
        context.awaitingProductChoice = false;
    }

    if (context.awaitingProductChoice) {
        const targetProduct = await getProductInfo(userMessage);
        if (targetProduct) {
            const productData = {
                name: targetProduct.name,
                brand: targetProduct.brand,
                description: targetProduct.description || 'Chưa có mô tả',
                price: formatPrice(targetProduct.price),
                colors: targetProduct.colors || 'Không có thông tin',
                storage: targetProduct.storage || 'Không có thông tin',
                release_date: targetProduct.release_date || 'Không có thông tin',
                warranty_period: targetProduct.warranty_period ? `${targetProduct.warranty_period} tháng` : 'Không có',
                promotion_names: targetProduct.promotion_names || '',
                features: targetProduct.features || ''
            };
            const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi về sản phẩm "${userMessage}". Dựa trên thông tin sản phẩm từ cơ sở dữ liệu: ${JSON.stringify(productData)}, hãy trả lời tự nhiên và cung cấp đầy đủ thông tin, đồng thời hỏi xem người dùng có muốn đặt mua không.`;
            const reply = await getGeminiResponse(prompt);

            context.awaitingProductChoice = false;
            context.lastProduct = targetProduct;
            context.lastBrand = targetProduct.brand;

            return res.json({ _text: reply, imageUrl: `/images/${targetProduct.image_url}`, showButtons: true });
        } else {
            const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi về sản phẩm "${userMessage}", nhưng không tìm thấy trong cơ sở dữ liệu. Hãy trả lời tự nhiên, giải thích rằng không tìm thấy và gợi ý người dùng thử lại.`;
            const reply = await getGeminiResponse(prompt);
            return res.json({ _text: reply });
        }
    }

    try {
        const witResponse = await getWitResponse(userMessage);
        if (!witResponse || !witResponse.intents) {
            const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}", nhưng hệ thống không thể nhận diện ý định. Hãy trả lời tự nhiên, xin lỗi và gợi ý người dùng thử lại hoặc cung cấp thêm thông tin.`;
            const reply = await getGeminiResponse(prompt);
            return res.json({ _text: reply });
        }

        const intent = witResponse.intents?.[0]?.name || null;
        let productName = witResponse.entities?.['product_name:product_name']?.[0]?.value || null;

        if (!productName || !userMessage.includes(productName.toLowerCase())) {
            productName = userMessage;
        }

        const priceRange = witResponse.entities?.['price_range:price_range']?.[0]?.value || null;
        const feature = witResponse.entities?.['feature:feature']?.[0]?.value || null;
        const color = witResponse.entities?.['color:color']?.[0]?.value || null;
        let brand = witResponse.entities?.['brand:brand']?.[0]?.value || extractBrandFromMessage(userMessage);

        if (brand && brand.toLowerCase() === 'iphone') {
            brand = 'Apple';
        }

        let reply = '';
        let imageUrl = null;
        let showButtons = false;
        let products = null;

        console.log('Intent:', intent);
        console.log('Product Name:', productName);
        console.log('Price Range:', priceRange);
        console.log('Feature:', feature);
        console.log('Color:', color);
        console.log('Brand:', brand);

        // Xử lý khi intent là null nhưng có brand
        if (!intent && brand) {
            const products = await findProductsByBrand(brand);
            if (products.length > 0) {
                const productList = products.map(p => ({
                    name: p.name,
                    brand: p.brand,
                    price: formatPrice(p.price),
                    image_url: p.image_url
                }));
                const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Dựa trên dữ liệu từ cơ sở dữ liệu, cửa hàng có các sản phẩm của thương hiệu ${brand}: ${JSON.stringify(productList)}. Hãy trả lời tự nhiên, liệt kê sản phẩm dưới dạng danh sách và hỏi xem người dùng có muốn chọn mẫu nào không.`;
                reply = await getGeminiResponse(prompt);
                context.lastBrand = brand;
                context.lastProduct = null;
                context.awaitingProductChoice = true;
                res.json({ _text: reply, imageUrl: null, showButtons: false, products });
                return;
            } else {
                const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Không tìm thấy sản phẩm nào của thương hiệu ${brand} trong cơ sở dữ liệu. Hãy trả lời tự nhiên, thông báo không có sản phẩm và gợi ý hỏi về thương hiệu khác.`;
                reply = await getGeminiResponse(prompt);
                context.lastBrand = null;
                res.json({ _text: reply });
                return;
            }
        }

        // Xử lý các intent
        if (intent === 'tim_kiem_theo_gia') {
            const regexRange = /từ\s+(\d+)\s+đến\s+(\d+)\s+triệu/i;
            const regexBelow = /dưới\s+(\d+)\s+triệu/i;
            const regexAbove = /trên\s+(\d+)\s+triệu/i;
            const regexHave = /có\s+(\d+)\s+triệu\s+mua\s+được/i;

            const matchRange = userMessage.match(regexRange);
            const matchBelow = userMessage.match(regexBelow);
            const matchAbove = userMessage.match(regexAbove);
            const matchHave = userMessage.match(regexHave);

            let minPrice = 0;
            let maxPrice = Infinity;

            if (priceRange) {
                const priceMatch = priceRange.match(/(\d+)/);
                if (priceMatch) {
                    maxPrice = parseInt(priceMatch[1]) * 1000000;
                }
            } else if (matchRange) {
                minPrice = parseInt(matchRange[1]) * 1000000;
                maxPrice = parseInt(matchRange[2]) * 1000000;
            } else if (matchBelow) {
                maxPrice = parseInt(matchBelow[1]) * 1000000;
            } else if (matchAbove) {
                minPrice = parseInt(matchAbove[1]) * 1000000;
                maxPrice = 999999999;
            } else if (matchHave) {
                maxPrice = parseInt(matchHave[1]) * 1000000;
            } else {
                const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Không thể hiểu rõ khoảng giá từ câu hỏi. Hãy trả lời tự nhiên, xin lỗi và gợi ý người dùng cung cấp thêm thông tin về ngân sách, ví dụ: "Có điện thoại nào dưới 10 triệu không?"`;
                reply = await getGeminiResponse(prompt);
                res.json({ _text: reply });
                return;
            }

            if (isNaN(minPrice) || isNaN(maxPrice) || minPrice > maxPrice) {
                const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Khoảng giá không hợp lệ. Hãy trả lời tự nhiên, thông báo lỗi và yêu cầu kiểm tra lại.`;
                reply = await getGeminiResponse(prompt);
                res.json({ _text: reply });
                return;
            }

            const products = await findProductsByPriceRange(minPrice, maxPrice);
            if (products.length > 0) {
                const productList = products.map(p => ({
                    name: p.name,
                    brand: p.brand,
                    price: formatPrice(p.price),
                    image_url: p.image_url
                }));
                const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Dựa trên dữ liệu từ cơ sở dữ liệu, đây là các sản phẩm trong khoảng giá từ ${formatPrice(minPrice)} đến ${formatPrice(maxPrice)}: ${JSON.stringify(productList)}. Hãy trả lời tự nhiên, liệt kê sản phẩm và hỏi xem người dùng có muốn chọn mẫu nào không.`;
                reply = await getGeminiResponse(prompt);
                res.json({ _text: reply, imageUrl: null, showButtons: false, products });
                return;
            } else {
                const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Không tìm thấy sản phẩm nào trong khoảng giá từ ${formatPrice(minPrice)} đến ${formatPrice(maxPrice)}. Hãy trả lời tự nhiên, thông báo không có sản phẩm và gợi ý xem các dòng khác.`;
                reply = await getGeminiResponse(prompt);
                res.json({ _text: reply });
                return;
            }
        } else if (intent === 'thong_tin_san_pham') {
            let targetProductName = productName || context.lastProduct?.name;
            if (!targetProductName) {
                const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}", nhưng không xác định được sản phẩm nào. Hãy trả lời tự nhiên, yêu cầu người dùng chỉ rõ sản phẩm, ví dụ: "Thông tin iPhone 14".`;
                reply = await getGeminiResponse(prompt);
                res.json({ _text: reply });
                return;
            }

            const product = await getProductInfo(targetProductName);
            if (product) {
                const productData = {
                    name: product.name,
                    brand: product.brand,
                    description: product.description || 'Chưa có mô tả',
                    price: formatPrice(product.price),
                    colors: product.colors || 'Không có thông tin',
                    storage: product.storage || 'Không có thông tin',
                    release_date: product.release_date || 'Không có thông tin',
                    warranty_period: product.warranty_period ? `${product.warranty_period} tháng` : 'Không có',
                    promotion_names: product.promotion_names || '',
                    features: product.features || ''
                };
                const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Dựa trên thông tin sản phẩm từ cơ sở dữ liệu: ${JSON.stringify(productData)}, hãy trả lời tự nhiên, cung cấp đầy đủ thông tin và hỏi xem người dùng có muốn đặt mua không.`;
                reply = await getGeminiResponse(prompt);
                imageUrl = `/images/${product.image_url}`;
                showButtons = true;
                context.lastProduct = product;
                context.lastBrand = product.brand;
                res.json({ _text: reply, imageUrl, showButtons });
                return;
            } else {
                const similarProducts = await suggestSimilarProducts(brand || context.lastBrand || 'Apple', targetProductName);
                if (similarProducts.length > 0) {
                    const similarList = similarProducts.map(p => ({
                        name: p.name,
                        brand: p.brand,
                        price: formatPrice(p.price),
                        image_url: p.image_url
                    }));
                    const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Không tìm thấy sản phẩm "${targetProductName}", nhưng có các sản phẩm tương tự: ${JSON.stringify(similarList)}. Hãy trả lời tự nhiên, thông báo không tìm thấy và liệt kê sản phẩm tương tự.`;
                    reply = await getGeminiResponse(prompt);
                } else {
                    const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Không tìm thấy sản phẩm "${targetProductName}" trong cơ sở dữ liệu và cũng không có sản phẩm tương tự. Hãy trả lời tự nhiên, thông báo không tìm thấy và gợi ý tìm sản phẩm khác.`;
                    reply = await getGeminiResponse(prompt);
                }
                res.json({ _text: reply });
                return;
            }
        } else if (intent === 'tu_van_san_pham') {
            let targetProductName = productName || context.lastProduct?.name;
            if (!targetProductName) {
                const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}", nhưng không chỉ rõ sản phẩm nào để tư vấn. Hãy trả lời tự nhiên, yêu cầu người dùng cung cấp tên sản phẩm, ví dụ: "Tư vấn iPhone 14".`;
                reply = await getGeminiResponse(prompt);
                res.json({ _text: reply });
                return;
            }

            const product = await getProductInfo(targetProductName);
            if (product) {
                const productData = {
                    name: product.name,
                    brand: product.brand,
                    description: product.description || 'Chưa có mô tả',
                    price: formatPrice(product.price),
                    colors: product.colors || 'Không có thông tin',
                    storage: product.storage || 'Không có thông tin',
                    release_date: product.release_date || 'Không có thông tin',
                    warranty_period: product.warranty_period ? `${product.warranty_period} tháng` : 'Không có',
                    promotion_names: product.promotion_names || '',
                    features: product.features || ''
                };

                if (!context.consultation.purpose) {
                    const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Dựa trên thông tin sản phẩm: ${JSON.stringify(productData)}, hãy trả lời tự nhiên, chào hỏi và hỏi người dùng về mục đích sử dụng điện thoại (ví dụ: chụp ảnh, chơi game, xem phim, làm việc).`;
                    reply = await getGeminiResponse(prompt);
                    context.consultation = { purpose: null, budget: null, feature: null, color: null };
                    imageUrl = `/images/${product.image_url}`;
                    res.json({ _text: reply, imageUrl });
                    return;
                } else if (!context.consultation.budget) {
                    context.consultation.purpose = userMessage;
                    const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng trả lời mục đích sử dụng: "${userMessage}". Dựa trên sản phẩm: ${JSON.stringify(productData)}, hãy trả lời tự nhiên, cảm ơn và hỏi về ngân sách của họ (ví dụ: 10 triệu, 20 triệu).`;
                    reply = await getGeminiResponse(prompt);
                    imageUrl = `/images/${product.image_url}`;
                    res.json({ _text: reply, imageUrl });
                    return;
                } else if (!context.consultation.feature) {
                    context.consultation.budget = userMessage;
                    const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng trả lời ngân sách: "${userMessage}". Dựa trên sản phẩm: ${JSON.stringify(productData)}, hãy trả lời tự nhiên, cảm ơn và hỏi về tính năng họ quan tâm (ví dụ: camera, hiệu năng, pin).`;
                    reply = await getGeminiResponse(prompt);
                    imageUrl = `/images/${product.image_url}`;
                    res.json({ _text: reply, imageUrl });
                    return;
                } else if (!context.consultation.color) {
                    context.consultation.feature = userMessage;
                    const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng trả lời tính năng quan tâm: "${userMessage}". Dựa trên sản phẩm: ${JSON.stringify(productData)}, hãy trả lời tự nhiên, cảm ơn và hỏi về màu sắc họ thích (ví dụ: đen, trắng, xanh).`;
                    reply = await getGeminiResponse(prompt);
                    imageUrl = `/images/${product.image_url}`;
                    res.json({ _text: reply, imageUrl });
                    return;
                } else {
                    context.consultation.color = userMessage;
                    const consultationData = {
                        purpose: context.consultation.purpose,
                        budget: context.consultation.budget,
                        feature: context.consultation.feature,
                        color: context.consultation.color
                    };
                    const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng trả lời màu sắc: "${userMessage}". Dựa trên thông tin sản phẩm: ${JSON.stringify(productData)} và thông tin tư vấn: ${JSON.stringify(consultationData)}, hãy trả lời tự nhiên, tóm tắt nhu cầu của họ và gợi ý sản phẩm phù hợp, sau đó hỏi xem họ có muốn xem chi tiết không.`;
                    reply = await getGeminiResponse(prompt);
                    context.consultation = { purpose: null, budget: null, feature: null, color: null };
                    context.lastProduct = product;
                    context.lastBrand = product.brand;
                    imageUrl = `/images/${product.image_url}`;
                    showButtons = true;
                    res.json({ _text: reply, imageUrl, showButtons });
                    return;
                }
            } else {
                const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Không tìm thấy sản phẩm "${targetProductName}" trong cơ sở dữ liệu. Hãy trả lời tự nhiên, thông báo không tìm thấy và gợi ý tư vấn sản phẩm khác.`;
                reply = await getGeminiResponse(prompt);
                res.json({ _text: reply });
                return;
            }
        } else if (intent === 'hoi_khuyen_mai') {
            let targetProductName = productName || context.lastProduct?.name;
            if (targetProductName) {
                const product = await getProductInfo(targetProductName);
                if (product) {
                    const productData = {
                        name: product.name,
                        promotion_names: product.promotion_names || 'Không có khuyến mãi'
                    };
                    const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Dựa trên thông tin sản phẩm từ cơ sở dữ liệu: ${JSON.stringify(productData)}, hãy trả lời tự nhiên về khuyến mãi và hỏi xem người dùng có muốn đặt mua không.`;
                    reply = await getGeminiResponse(prompt);
                    imageUrl = `/images/${product.image_url}`;
                    showButtons = true;
                    context.lastProduct = product;
                    context.lastBrand = product.brand;
                    res.json({ _text: reply, imageUrl, showButtons });
                    return;
                } else {
                    const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Không tìm thấy sản phẩm "${targetProductName}" trong cơ sở dữ liệu. Hãy trả lời tự nhiên, thông báo không tìm thấy và gợi ý hỏi về sản phẩm khác.`;
                    reply = await getGeminiResponse(prompt);
                    res.json({ _text: reply });
                    return;
                }
            } else {
                const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}", nhưng không chỉ rõ sản phẩm nào. Hãy trả lời tự nhiên, yêu cầu người dùng chỉ rõ sản phẩm, ví dụ: "iPhone 14 có khuyến mãi gì không?"`;
                reply = await getGeminiResponse(prompt);
                res.json({ _text: reply });
                return;
            }
        } else if (intent === 'hoi_bao_hanh') {
            let targetProductName = productName || context.lastProduct?.name;
            if (targetProductName) {
                const product = await getProductInfo(targetProductName);
                if (product) {
                    const productData = {
                        name: product.name,
                        warranty_period: product.warranty_period ? `${product.warranty_period} tháng` : 'Không có thông tin'
                    };
                    const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Dựa trên thông tin sản phẩm từ cơ sở dữ liệu: ${JSON.stringify(productData)}, hãy trả lời tự nhiên về bảo hành và hỏi xem người dùng có muốn biết thêm thông tin không.`;
                    reply = await getGeminiResponse(prompt);
                    imageUrl = `/images/${product.image_url}`;
                    showButtons = true;
                    context.lastProduct = product;
                    context.lastBrand = product.brand;
                    res.json({ _text: reply, imageUrl, showButtons });
                    return;
                } else {
                    const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Không tìm thấy sản phẩm "${targetProductName}" trong cơ sở dữ liệu. Hãy trả lời tự nhiên, thông báo không tìm thấy và gợi ý hỏi về sản phẩm khác.`;
                    reply = await getGeminiResponse(prompt);
                    res.json({ _text: reply });
                    return;
                }
            } else {
                const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}", nhưng không chỉ rõ sản phẩm nào. Hãy trả lời tự nhiên, yêu cầu người dùng chỉ rõ sản phẩm, ví dụ: "Bảo hành của Galaxy S23 bao lâu?"`;
                reply = await getGeminiResponse(prompt);
                res.json({ _text: reply });
                return;
            }
        } else if (intent === 'tim_kiem_theo_thuong_hieu') {
            let targetBrand = brand || context.lastBrand;
            if (targetBrand) {
                const products = await findProductsByBrand(targetBrand);
                if (products.length > 0) {
                    const productList = products.map(p => ({
                        name: p.name,
                        brand: p.brand,
                        price: formatPrice(p.price),
                        image_url: p.image_url
                    }));
                    const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Dựa trên dữ liệu từ cơ sở dữ liệu, đây là các sản phẩm của ${targetBrand}: ${JSON.stringify(productList)}. Hãy trả lời tự nhiên, liệt kê sản phẩm và hỏi xem người dùng có muốn chọn mẫu nào không.`;
                    reply = await getGeminiResponse(prompt);
                    context.lastBrand = targetBrand;
                    context.lastProduct = null;
                    context.awaitingProductChoice = true;
                    res.json({ _text: reply, imageUrl: null, showButtons: false, products });
                    return;
                } else {
                    const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Không tìm thấy sản phẩm nào của ${targetBrand} trong cơ sở dữ liệu. Hãy trả lời tự nhiên, thông báo không có sản phẩm và gợi ý hỏi về thương hiệu khác.`;
                    reply = await getGeminiResponse(prompt);
                    context.lastBrand = null;
                    res.json({ _text: reply });
                    return;
                }
            } else {
                const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}", nhưng không xác định được thương hiệu. Hãy trả lời tự nhiên, yêu cầu người dùng chỉ rõ thương hiệu, ví dụ: "Có sản phẩm nào của Samsung không?"`;
                reply = await getGeminiResponse(prompt);
                res.json({ _text: reply });
                return;
            }
        } else if (intent === 'hoi_gia') {
            let targetProductName = productName || context.lastProduct?.name;
            if (targetProductName) {
                const product = await getProductInfo(targetProductName);
                if (product) {
                    const productData = {
                        name: product.name,
                        price: formatPrice(product.price)
                    };
                    const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Dựa trên thông tin sản phẩm từ cơ sở dữ liệu: ${JSON.stringify(productData)}, hãy trả lời tự nhiên về giá và hỏi xem người dùng có muốn biết thêm thông tin không.`;
                    reply = await getGeminiResponse(prompt);
                    imageUrl = `/images/${product.image_url}`;
                    showButtons = true;
                    context.lastProduct = product;
                    context.lastBrand = product.brand;
                    res.json({ _text: reply, imageUrl, showButtons });
                    return;
                } else {
                    const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Không tìm thấy sản phẩm "${targetProductName}" trong cơ sở dữ liệu. Hãy trả lời tự nhiên, thông báo không tìm thấy và gợi ý hỏi về sản phẩm khác.`;
                    reply = await getGeminiResponse(prompt);
                    res.json({ _text: reply });
                    return;
                }
            } else {
                const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}", nhưng không chỉ rõ sản phẩm nào. Hãy trả lời tự nhiên, yêu cầu người dùng chỉ rõ sản phẩm, ví dụ: "iPhone 14 giá bao nhiêu?"`;
                reply = await getGeminiResponse(prompt);
                res.json({ _text: reply });
                return;
            }
        } else if (intent === 'hoi_mau_sac') {
            let targetProductName = productName || context.lastProduct?.name;
            if (targetProductName) {
                const product = await getProductInfo(targetProductName);
                if (product) {
                    const productData = {
                        name: product.name,
                        colors: product.colors || 'Không có thông tin'
                    };
                    const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Dựa trên thông tin sản phẩm từ cơ sở dữ liệu: ${JSON.stringify(productData)}, hãy trả lời tự nhiên về màu sắc và hỏi xem người dùng có muốn biết thêm thông tin không.`;
                    reply = await getGeminiResponse(prompt);
                    imageUrl = `/images/${product.image_url}`;
                    showButtons = true;
                    context.lastProduct = product;
                    context.lastBrand = product.brand;
                    res.json({ _text: reply, imageUrl, showButtons });
                    return;
                } else {
                    const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Không tìm thấy sản phẩm "${targetProductName}" trong cơ sở dữ liệu. Hãy trả lời tự nhiên, thông báo không tìm thấy và gợi ý hỏi về sản phẩm khác.`;
                    reply = await getGeminiResponse(prompt);
                    res.json({ _text: reply });
                    return;
                }
            } else {
                const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}", nhưng không chỉ rõ sản phẩm nào. Hãy trả lời tự nhiên, yêu cầu người dùng chỉ rõ sản phẩm, ví dụ: "iPhone 14 có màu gì?"`;
                reply = await getGeminiResponse(prompt);
                res.json({ _text: reply });
                return;
            }
        } else if (intent === 'hoi_tra_gop') {
            let targetProductName = productName || context.lastProduct?.name;
            if (targetProductName) {
                const product = await getProductInfo(targetProductName);
                if (product) {
                    const productData = {
                        name: product.name,
                        price: formatPrice(product.price),
                        tra_gop: 'Hỗ trợ trả góp 0% lãi suất trong 6 tháng'
                    };
                    const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Dựa trên thông tin sản phẩm từ cơ sở dữ liệu: ${JSON.stringify(productData)}, hãy trả lời tự nhiên về trả góp và hỏi xem người dùng có muốn biết thêm hoặc đặt mua không.`;
                    reply = await getGeminiResponse(prompt);
                    imageUrl = `/images/${product.image_url}`;
                    showButtons = true;
                    context.lastProduct = product;
                    context.lastBrand = product.brand;
                    res.json({ _text: reply, imageUrl, showButtons });
                    return;
                } else {
                    const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Không tìm thấy sản phẩm "${targetProductName}" trong cơ sở dữ liệu. Hãy trả lời tự nhiên, thông báo không tìm thấy và gợi ý hỏi về sản phẩm khác.`;
                    reply = await getGeminiResponse(prompt);
                    res.json({ _text: reply });
                    return;
                }
            } else {
                const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}", nhưng không chỉ rõ sản phẩm nào. Hãy trả lời tự nhiên, yêu cầu người dùng chỉ rõ sản phẩm, ví dụ: "iPhone 14 có trả góp không?"`;
                reply = await getGeminiResponse(prompt);
                res.json({ _text: reply });
                return;
            }
        } else if (intent === 'so_sanh_san_pham') {
            const productName1 = witResponse.entities?.['product_name:product_name']?.[0]?.value || null;
            const productName2 = witResponse.entities?.['product_name:product_name']?.[1]?.value || null;

            if (productName1 && productName2) {
                const comparison = await compareProducts(productName1, productName2);
                if (comparison) {
                    const { product1, product2 } = comparison;
                    const comparisonData = {
                        product1: {
                            name: product1.name,
                            price: formatPrice(product1.price),
                            colors: product1.colors || 'Không có thông tin',
                            storage: product1.storage || 'Không có thông tin',
                            features: product1.features || 'Không có thông tin'
                        },
                        product2: {
                            name: product2.name,
                            price: formatPrice(product2.price),
                            colors: product2.colors || 'Không có thông tin',
                            storage: product2.storage || 'Không có thông tin',
                            features: product2.features || 'Không có thông tin'
                        }
                    };
                    const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Dựa trên thông tin từ cơ sở dữ liệu: ${JSON.stringify(comparisonData)}, hãy trả lời tự nhiên, so sánh hai sản phẩm và hỏi xem người dùng có muốn xem chi tiết không.`;
                    reply = await getGeminiResponse(prompt);
                    context.lastProduct = null;
                    context.lastBrand = null;
                    res.json({ _text: reply });
                    return;
                } else {
                    const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Không tìm thấy một trong hai sản phẩm "${productName1}" hoặc "${productName2}" trong cơ sở dữ liệu. Hãy trả lời tự nhiên, thông báo lỗi và gợi ý thử lại.`;
                    reply = await getGeminiResponse(prompt);
                    res.json({ _text: reply });
                    return;
                }
            } else {
                const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}", nhưng không cung cấp đủ tên hai sản phẩm để so sánh. Hãy trả lời tự nhiên, yêu cầu người dùng chỉ rõ hai sản phẩm, ví dụ: "So sánh iPhone 14 và Galaxy S23".`;
                reply = await getGeminiResponse(prompt);
                res.json({ _text: reply });
                return;
            }
        } else if (intent === 'tim_kiem_thuong_hieu_mau') {
            let targetBrand = brand || context.lastBrand;
            if (targetBrand && color) {
                const products = await findProductsByBrand(targetBrand, null, color);
                if (products.length > 0) {
                    const productList = products.map(p => ({
                        name: p.name,
                        brand: p.brand,
                        price: formatPrice(p.price),
                        image_url: p.image_url
                    }));
                    const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Dựa trên dữ liệu từ cơ sở dữ liệu, đây là các sản phẩm của ${targetBrand} màu ${color}: ${JSON.stringify(productList)}. Hãy trả lời tự nhiên, liệt kê sản phẩm và hỏi xem người dùng có muốn xem chi tiết không.`;
                    reply = await getGeminiResponse(prompt);
                    context.lastBrand = targetBrand;
                    context.lastProduct = null;
                    res.json({ _text: reply, imageUrl: null, showButtons: false, products });
                    return;
                } else {
                    const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Không tìm thấy sản phẩm nào của ${targetBrand} màu ${color} trong cơ sở dữ liệu. Hãy trả lời tự nhiên, thông báo không có sản phẩm và gợi ý xem màu khác.`;
                    reply = await getGeminiResponse(prompt);
                    context.lastBrand = null;
                    res.json({ _text: reply });
                    return;
                }
            } else {
                const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}", nhưng không đủ thông tin về thương hiệu hoặc màu sắc. Hãy trả lời tự nhiên, yêu cầu người dùng chỉ rõ thương hiệu và màu, ví dụ: "Có sản phẩm Samsung màu đen không?"`;
                reply = await getGeminiResponse(prompt);
                res.json({ _text: reply });
                return;
            }
        } else if (intent === 'hoi_mau_san_pham') {
            let targetBrand = brand || extractBrandFromMessage(userMessage);
            if (targetBrand && targetBrand.toLowerCase() === 'iphone') {
                targetBrand = 'Apple'; // Nếu thương hiệu là 'iphone', chuyển thành 'Apple'
            }
        
            if (targetBrand) {
                const productList = await findProductsByBrand(targetBrand);  // Lấy danh sách sản phẩm từ cơ sở dữ liệu
                if (productList.length > 0) {
                    products = productList.map(p => ({
                        name: p.name,
                        brand: p.brand,
                        price: formatPrice(p.price),
                        image_url: p.image_url ? `/images/${p.image_url}` : '/images/default.jpg'  // Hình ảnh mặc định nếu không có hình ảnh
                    }));
        
                    // Tạo HTML để hiển thị sản phẩm kèm hình ảnh
                    let productGrid = '<div class="product-grid">';
                    products.forEach(product => {
                        const imageSrc = product.image_url; // Lấy đường dẫn hình ảnh
                        productGrid += `
                            <div class="product-card">
                                <img src="${imageSrc}" class="product-image" alt="${product.name}">
                                <div class="product-info">
                                    <h3>${product.name}</h3>
                                    <p>${product.price}</p>
                                    <button class="buy-btn" data-product-name="${product.name}">Chọn mẫu này</button>
                                </div>
                            </div>
                        `;
                    });
                    productGrid += '</div>';
        
                    // Gửi prompt đến Gemini AI để tạo câu trả lời tự nhiên với các sản phẩm
                    const prompt = `Mình là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Dựa trên dữ liệu từ cơ sở dữ liệu, đây là các sản phẩm của ${targetBrand}. Hãy trả lời tự nhiên, liệt kê sản phẩm dưới dạng văn bản và hỏi xem người dùng có muốn chọn mẫu nào không. Dưới đây là HTML để hiển thị danh sách: ${productGrid}`;
        
                    // Lấy phản hồi từ Gemini AI
                    reply = await getGeminiResponse(prompt);
        
                    context.lastBrand = targetBrand;
                    context.lastProduct = null;
                    context.awaitingProductChoice = true;  // Đảm bảo frontend xử lý trạng thái này
        
                    // Trả lời người dùng với thông tin sản phẩm và hình ảnh
                    res.json({ _text: reply, imageUrl: products[0].image_url, showButtons: true, products, productGrid });
                    return;
                } else {
                    // Nếu không tìm thấy sản phẩm nào của thương hiệu, trả lời không tìm thấy
                    const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Không tìm thấy sản phẩm nào của ${targetBrand} trong cơ sở dữ liệu. Hãy trả lời tự nhiên, thông báo không có sản phẩm và gợi ý hỏi về thương hiệu khác.`;
                    reply = await getGeminiResponse(prompt);
                    context.lastBrand = null;
                    res.json({ _text: reply });
                    return;
                }
            } else {
                // Nếu không xác định được thương hiệu, yêu cầu người dùng cung cấp thêm thông tin
                const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}", nhưng không xác định được thương hiệu. Hãy trả lời tự nhiên, yêu cầu người dùng chỉ rõ thương hiệu, ví dụ: "Shop có bán iPhone không?"`;
                reply = await getGeminiResponse(prompt);
                res.json({ _text: reply });
                return;
            }
        }
        
         else if (intent === 'hoi_tinh_trang_hang') {
            const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Hãy trả lời tự nhiên rằng tất cả sản phẩm đều chính hãng, mới 100% và còn nguyên bảo hành, sau đó hỏi xem người dùng có muốn xem chi tiết sản phẩm nào không.`;
            reply = await getGeminiResponse(prompt);
            res.json({ _text: reply });
            return;
        } else {
            const contextPrompt = {
                lastProduct: context.lastProduct?.name || 'không có sản phẩm',
                lastBrand: context.lastBrand || 'không có thương hiệu',
                lastIntent: context.lastIntent || 'không có intent',
                history: context.history.slice(-3),
                consultation: context.consultation
            };
            const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Người dùng hỏi: "${userMessage}". Không nhận diện được ý định cụ thể. Dựa trên ngữ cảnh: ${JSON.stringify(contextPrompt)}, hãy trả lời tự nhiên và phù hợp.`;
            reply = await getGeminiResponse(prompt);
            context.lastProduct = null;
            context.lastBrand = null;
        }

        context.lastIntent = intent;
        context.history.push({ intent, productName, brand, userMessage, reply });
        if (context.history.length > 10) context.history.shift();

        console.log(`🤖 Bot: ${reply}`);
        res.json({ _text: reply, imageUrl, showButtons, products });
    } catch (error) {
        console.error("❌ Lỗi tổng quát trong chatbot:", error);
        const prompt = `Bạn là chatbot của một cửa hàng điện thoại. Đã xảy ra lỗi khi xử lý câu hỏi: "${userMessage}". Hãy trả lời tự nhiên, xin lỗi và gợi ý thử lại sau.`;
        reply = await getGeminiResponse(prompt);
        res.json({ _text: reply });
    }
});

// Chạy server
app.listen(PORT, () => {
    console.log(`🚀 Server đang chạy tại: http://localhost:${PORT}`);
});