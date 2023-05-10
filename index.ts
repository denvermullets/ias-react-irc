import { Config, interpolate } from "@pulumi/pulumi";
import { types, remote, local } from "@pulumi/command";
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

// Define the name and region for the AWS resources.
const appName = "react-irc";
const region = aws.config.region || "us-east-1";

const config = new Config();
const publicKey = fs.readFileSync("public-react-irc.pub", "utf-8");

// Create a new key pair using the public key
const keyPair = new aws.ec2.KeyPair("react-irc-deployment", { publicKey });

// Use the key name from the new key pair
const finalKeyName = keyPair.keyName;

const privateKeyBase64 = config.get("privateKeyBase64");
const privateKey = privateKeyBase64
  ? Buffer.from(privateKeyBase64, "base64").toString("ascii")
  : fs
      .readFileSync(path.join(__dirname, "react-irc-deployment.pem"))
      .toString("utf8");

// Then in your EC2 instance configuration
function getFilesRecursively(dirPath: string, files: string[] = []): string[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      getFilesRecursively(fullPath, files);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

// Create an S3 bucket to store your client code.
const bucket = new aws.s3.Bucket(`${appName}-bucket`, {
  website: {
    indexDocument: "index.html",
    errorDocument: "index.html",
  },
  corsRules: [
    {
      allowedHeaders: ["*"],
      allowedMethods: ["GET", "HEAD"],
      allowedOrigins: ["*"],
      exposeHeaders: [],
    },
  ],
});

// Upload the client code to the S3 bucket.
const clientDistDir = path.join(__dirname, `${appName}/client/dist`);
const files = getFilesRecursively(clientDistDir);

for (const file of files) {
  const relativePath = path.relative(clientDistDir, file);
  const key = relativePath.replace(/\\/g, "/");
  // Replace backslashes with forward slashes on Windows
  // const key = "client/" + relativePath.replace(/\\/g, "/");

  new aws.s3.BucketObject(relativePath, {
    bucket: bucket.id,
    key: key,
    source: new pulumi.asset.FileAsset(file),
    contentType: "text/html",
  });
}

const vpc = new aws.ec2.Vpc("react-irc-vpc", {
  cidrBlock: "10.0.0.0/16",
});

// Define the security group for the EC2 instance.
// 0.0.0.0/0 allows any IP, currently restricting to home
const sg = new aws.ec2.SecurityGroup(`${appName}-sg`, {
  vpcId: vpc.id,
  description: "add ssh port, http port and react app port",
  ingress: [
    {
      protocol: "tcp",
      fromPort: 22,
      toPort: 22,
      cidrBlocks: ["0.0.0.0/0"],
    },
    { protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"] },
    {
      protocol: "tcp",
      fromPort: 3000,
      toPort: 3000,
      cidrBlocks: ["0.0.0.0/0"],
    }, // react app port
  ],
  egress: [
    {
      protocol: "-1", // -1 stands for all protocols
      fromPort: 0,
      toPort: 0,
      cidrBlocks: ["0.0.0.0/0"], // allow all IPs
    },
  ],
});

// Create a security group for the database
const dbSg = new aws.ec2.SecurityGroup(`${appName}-db-sg`, {
  vpcId: vpc.id,
  ingress: [
    {
      protocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      securityGroups: [sg.id],
    },
  ],
});

const subnet = new aws.ec2.Subnet("react-irc-subnet", {
  cidrBlock: "10.0.1.0/24",
  vpcId: vpc.id,
  availabilityZone: "us-east-1a",
  // sets the subnet IP to be public so we can SSH
  mapPublicIpOnLaunch: true,
});

const subnet2 = new aws.ec2.Subnet("react-irc-subnet-2", {
  cidrBlock: "10.0.2.0/24",
  vpcId: vpc.id,
  availabilityZone: "us-east-1b",
});

// Create an Internet Gateway and attach it to the VPC.
const igw = new aws.ec2.InternetGateway(`${appName}-igw`, {
  vpcId: vpc.id,
});

// Create a Route Table, associate it with our VPC, and add a route to the IGW.
const routeTable = new aws.ec2.RouteTable(`${appName}-route-table`, {
  vpcId: vpc.id,
  routes: [
    {
      cidrBlock: "0.0.0.0/0",
      gatewayId: igw.id,
    },
  ],
});

// Associate the Route Table with our Subnets.
const routeTableAssociation1 = new aws.ec2.RouteTableAssociation(
  `${appName}-rta1`,
  {
    subnetId: subnet.id,
    routeTableId: routeTable.id,
  }
);

const routeTableAssociation2 = new aws.ec2.RouteTableAssociation(
  `${appName}-rta2`,
  {
    subnetId: subnet2.id,
    routeTableId: routeTable.id,
  }
);

const dbSubnetGroup = new aws.rds.SubnetGroup("react-irc-db-subnet-group", {
  subnetIds: [subnet.id, subnet2.id],
});

// Create a PostgreSQL database instance using AWS RDS.
const dbName = appName.replace(/[^a-zA-Z0-9]/g, "");
const dbPassword = "mysecretpassword";
const dbInstance = new aws.rds.Instance(`${appName}-db`, {
  engine: "postgres",
  instanceClass: "db.t4g.micro",
  allocatedStorage: 5,
  dbSubnetGroupName: dbSubnetGroup.name,
  vpcSecurityGroupIds: [dbSg.id],
  name: dbName,
  username: "postgres",
  password: dbPassword,
  tags: { Name: `${appName}-db` },
  skipFinalSnapshot: true,
});

// Get the id for the latest Amazon Linux AMI
const amiId = aws.ec2
  .getAmi({
    filters: [{ name: "name", values: ["amzn-ami-hvm-*-x86_64-ebs"] }],
    owners: ["137112412989"], // Amazon
    mostRecent: true,
  })
  .then((result) => result.id);

// Store the values of bucket.id and dbInstance.endpoint
const bucketName = bucket.id;
const dbEndpoint = dbInstance.endpoint;

const userDataScript = `#!/bin/bash
export NODE_ENV=production
export PORT=8080
export BUCKET_NAME=${bucketName}
export DATABASE_URL=postgres://postgres:${dbPassword}@${dbEndpoint}/5432/${appName}
sudo curl -fsSL https://deb.nodesource.com/setup_18.x | sudo bash -
sudo apt-get install -y nodejs git
sudo npm install -g pm2
cd /home/ubuntu
git clone https://github.com/denvermullets/react-irc.git
cd react-irc
cd server
npm install
npm run build
pm2 start dist/index.js --name server
`;

const instancePolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Action: ["s3:*"],
      Effect: "Allow",
      Resource: "*",
    },
    {
      Action: ["ec2:*"],
      Effect: "Allow",
      Resource: "*",
    },
  ],
};

const instancePolicy = new aws.iam.Policy("instancePolicy", {
  policy: JSON.stringify(instancePolicyDocument),
});

const instanceRole = new aws.iam.Role("instanceRole", {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Action: "sts:AssumeRole",
        Effect: "Allow",
        Principal: {
          Service: "ec2.amazonaws.com",
        },
      },
    ],
  }),
});

const instanceRolePolicyAttachment = new aws.iam.RolePolicyAttachment(
  "instanceRolePolicyAttachment",
  {
    policyArn: instancePolicy.arn,
    role: instanceRole.name,
  }
);

const instanceProfile = new aws.iam.InstanceProfile("instanceProfile", {
  role: instanceRole.name,
});

const instance = new aws.ec2.Instance(`${appName}-instance`, {
  ami: amiId,
  instanceType: "t2.nano",
  tags: { Name: `${appName}-server` },
  keyName: finalKeyName,
  subnetId: subnet.id,
  iamInstanceProfile: instanceProfile.name,
  userData: userDataScript,
  vpcSecurityGroupIds: [sg.id],
});

// attempting to add commands for server to run
const connection: types.input.remote.ConnectionArgs = {
  host: instance.publicIp,
  // user: "ubuntu",
  user: "ec2-user",
  privateKey: privateKey,
};

const setupScript = pulumi.interpolate`#!/bin/bash
if ! command -v node &> /dev/null
then
    curl -sL https://rpm.nodesource.com/setup_16.x | sudo bash -
    sudo yum install -y nodejs
fi

export NODE_ENV=production
export PORT=8080
export BUCKET_NAME=${bucketName}
export DATABASE_URL=postgres://postgres:${dbPassword}@${dbEndpoint}:5432/${appName}

if ! command -v git &> /dev/null
then
    sudo yum install -y git
fi

if ! command -v pm2 &> /dev/null
then
    sudo npm install -g pm2
fi

if ! command -v tsc &> /dev/null
then
    sudo npm install -g typescript
fi

cd /home/ec2-user

echo "checking for existing repo"
if [ -d "react-irc" ]
then
    echo "deleting repo"
    rm -rf react-irc
fi

git clone https://github.com/denvermullets/react-irc.git

cd react-irc
cd server

npm install

npm run prod:build
pm2 start dist/index.js --name server`;

new remote.Command(
  "setupApplication",
  {
    connection,
    create: setupScript,
  },
  { deleteBeforeReplace: true }
);

// Export the public URL of the S3 bucket.
export const clientUrl = pulumi.interpolate`http://${bucket.websiteEndpoint}`;

// Export the public IP address of the EC2 instance.
export const serverIp = instance.publicIp;
