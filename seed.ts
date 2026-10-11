import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { DEFAULT_SETTINGS } from '../src/services/defaultSettings';

const prisma = new PrismaClient();

const CATEGORIES = ['Shoes', 'Bags', 'Perfume', 'Skincare', 'Clothes', 'Makeup'];

async function main() {
  // 1. Shop rules (only added if missing, so changes you make later are never overwritten)
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await prisma.setting.upsert({ where: { key }, update: {}, create: { key, value: value as never } });
  }

  // 2. Categories
  for (const [i, name] of CATEGORIES.entries()) {
    const slug = name.toLowerCase();
    await prisma.category.upsert({ where: { slug }, update: {}, create: { name, slug, sort: i } });
  }

  // 3. The first owner account
  const ownerEmail = process.env.SEED_OWNER_EMAIL?.trim().toLowerCase();
  const ownerPassword = process.env.SEED_OWNER_PASSWORD;
  if (ownerEmail && ownerPassword) {
    await prisma.user.upsert({
      where: { email: ownerEmail },
      update: {},
      create: {
        email: ownerEmail,
        name: 'Owner',
        role: 'OWNER',
        passwordHash: await bcrypt.hash(ownerPassword, 12),
        emailVerifiedAt: new Date(),
        referralCode: 'DHOWNER1',
      },
    });
    console.log(`Owner account ready: ${ownerEmail}`);
  } else {
    console.log('SEED_OWNER_EMAIL / SEED_OWNER_PASSWORD not set: no owner account created.');
  }

  // 4. Optional demo products so the app has something to show while testing (set SEED_DEMO=true)
  if (process.env.SEED_DEMO === 'true') {
    for (const [i, name] of CATEGORIES.entries()) {
      const slug = `demo-${name.toLowerCase()}`;
      const category = await prisma.category.findUniqueOrThrow({ where: { slug: name.toLowerCase() } });
      const sizes = name === 'Shoes' ? ['38', '39', '40', '41'] : [null];
      await prisma.product.upsert({
        where: { slug },
        update: {},
        create: {
          name: `Demo ${name}`,
          slug,
          description: 'Demo product for testing. Delete it before you launch.',
          categoryId: category.id,
          price: 1_500_000 + i * 250_000, // kobo: 15,000 naira and up
          salePrice: i % 2 === 0 ? 1_200_000 + i * 250_000 : null,
          isFeatured: true,
          isNewArrival: i % 3 === 0,
          status: 'PUBLISHED',
          variants: { create: sizes.map((size) => ({ size, sku: `${slug}-${size ?? 'one'}`, stock: 8 })) },
        },
      });
    }
    console.log('Demo products added.');
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
